import styleLoader from "bun-style-loader";
import { watch as fswatch } from "fs";
import winston from "winston";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import path from "path";
import type { PackageJson } from "type-fest";

const consoleTransport = new winston.transports.Console();
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.cli(),
    winston.format.printf(
      (info) =>
        `${info.timestamp} ${info.level}: ${info.message}` +
        (info.splat !== undefined ? `${info.splat}` : " ")
    )
  ),
  transports: [consoleTransport],
  exceptionHandlers: [consoleTransport],
  rejectionHandlers: [consoleTransport],
  exitOnError: false,
});

const MINIMAL_USER_SCRIPT_HEADER_ITEMS = [
  "@name",
  "@namespace",
  "@version",
  "@description",
  "@license",
  "@author",
  "@updateURL",
  "@downloadURL",
] as const;

const MINIMAL_USER_SCRIPT_HEADER_SET: Set<
  (typeof MINIMAL_USER_SCRIPT_HEADER_ITEMS)[number]
> = new Set(MINIMAL_USER_SCRIPT_HEADER_ITEMS);

type MinimalUserScriptHeader = {
  [K in typeof MINIMAL_USER_SCRIPT_HEADER_ITEMS[number]]: string[] | string;
};

type UserScriptHeader = MinimalUserScriptHeader & {
  [k: string]: string[] | string;
};

type ExtendedPackageJson = PackageJson & {
  userscriptHeader: UserScriptHeader;
};

interface ScriptOptions {
  entrypointPath: string;
  headerOverride?: UserScriptHeader;
}

function generateHeader(): UserScriptHeader {
  const packageJsonPath = "./package.json";
  const packageJson: ExtendedPackageJson = require(packageJsonPath);

  if (
    !packageJson.name ||
    !packageJson.version ||
    !packageJson.description ||
    !packageJson.license ||
    !packageJson.author ||
    !packageJson.repository
  ) {
    throw new Error("Missing required fields in package.json");
  }

  const distUserScript = `${packageJson.name}.user.js`;
  const url = (packageJson.repository as { url: string }).url
    .replace("git+", "")
    .replace(".git", "");
  const updateUrl = `${url}/raw/main/dist/${distUserScript}`;
  const downloadUrl = updateUrl;

  const defaultHeader: MinimalUserScriptHeader = {
    "@name": packageJson.name,
    "@namespace": url,
    "@version": packageJson.version,
    "@description": packageJson.description,
    "@license": packageJson.license,
    "@author": packageJson.author.toString(),
    "@updateURL": updateUrl,
    "@downloadURL": downloadUrl,
  };
  const header: UserScriptHeader = {
    ...defaultHeader,
  };

  for (const key in packageJson.userscriptHeader) {
    const value = packageJson.userscriptHeader[key];
    if (typeof key !== "string") {
      logger.warn(`ignore non-string key in userscript header: "${key}"="${value}"`)
    };

    header[key] = value;
  }
  return header;
}

async function postBuildScript(options: ScriptOptions): Promise<void> {
  const { entrypointPath, headerOverride = {} } = options;
  const header: UserScriptHeader = {
    ...generateHeader(),
    ...headerOverride,
  };

  const longestHeaderChar = Math.max(...Object.keys(header).map(k => k.length));

  const HEADER_BEGIN = "// ==UserScript==\n";
  const HEADER_END = "// ==/UserScript==\n\n";

  const distUserScript = `${header["@name"]}.user.js`;
  const outputPath = `${path.dirname(entrypointPath)}/${distUserScript}`;
  const data = await Bun.file(entrypointPath).text();
  let output = HEADER_BEGIN;

  for (const key of MINIMAL_USER_SCRIPT_HEADER_ITEMS) {
    const value = header[key];
    for (const row of typeof value === "string" ? [value] : value) {
      output += `// ${key.padEnd(longestHeaderChar)}  ${row}\n`;
    }
  }

  for (const key in header) {
    if (MINIMAL_USER_SCRIPT_HEADER_SET.has(key as any)) {
      continue;
    }
    const value = header[key];
    for (const row of typeof value === "string" ? [value] : value) {
      output += `// ${key.padEnd(longestHeaderChar)}  ${row}\n`;
    }
  }
  output += HEADER_END;
  output += data;

  await Bun.write(outputPath, output);
  logger.info(`Successfully added the header to the userscript ${outputPath}!`);
}

interface BuildOptions {
  dev?: boolean;
}

async function build(params: BuildOptions) {
  const { dev = false } = params;
  const entrypoint = "./src/index.ts";

  logger.info(`Building ${entrypoint}`);
  const build = await Bun.build({
    entrypoints: [entrypoint],
    outdir: "./dist",
    minify: !dev,
    sourcemap: dev ? "inline" : undefined,
    loader: {
      ".html": "text",
    },
    plugins: [styleLoader()],
  });

  logger.info(Bun.inspect(build, { colors: true }));

  if (!build.success) {
    throw new Error("Bun build return errors");
  }

  const entrypointPath = build.outputs.find(
    (artifact) => artifact.kind === "entry-point"
  )?.path;
  logger.info(`Running post build script with entrypoint ${entrypointPath}.`);
  if (!entrypointPath) {
    throw new Error("Cannot find entrypoint in built artifacts.");
  }

  await postBuildScript({ entrypointPath });
}

interface Watcher {
  close: () => void;
}

function watch(params: BuildOptions): Watcher {
  let stopped: boolean = false;
  const watchPath = `${import.meta.dir}/src`;
  const watcher = fswatch(watchPath, { recursive: true }, (event, filename) => {
    if (stopped) return;
    logger.info(`Detected ${event} in ${filename}`);
    build(params);
  });
  logger.info(`Watching path ${watchPath}`);
  return {
    close: () => {
      logger.info("Closing watcher...");
      stopped = true;
      watcher.close();
    },
  };
}

interface Server {
  close: () => void;
}

function serve(): Server {
  const server = Bun.serve({
    static: {
      "/": Response.redirect("/script.user.js"),
    },
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/script.user.js")
        return new Response(
          Bun.file("./dist/bun-ts-userscript-starter.user.js")
        );
      return new Response("404!");
    },
  });
  logger.info(`Listening on http://${server.hostname}:${server.port}/`);
  return {
    close: () => {
      logger.info("Stopping dev server...");
      server.stop();
      server.unref();
    },
  };
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("dev", {
      type: "boolean",
      description:
        "Build in development mode, which disables minify and enables inline source map",
      default: false,
    })
    .option("server", {
      type: "boolean",
      description: "Start a local HTTP server for the generated user script",
      default: false,
    })
    .option("watch", {
      type: "boolean",
      description:
        "Watch src folder and build whenever change happens to its files",
      default: false,
    })
    .parse();

  const params: BuildOptions = {
    dev: argv.dev,
  };

  // initial building is always needed, even for watching build
  await build(params);

  if (argv.server) {
    const s = serve();
    process.on("SIGINT", () => {
      s.close();
    });
  }

  if (argv.watch) {
    const w = watch(params);
    process.on("SIGINT", () => {
      w.close();
    });
  }
}

await main();
