import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { build } from "vite";

const PELE_SCRIPT_URL_SUFFIX = "/mermaid-renderer/src/pele-script-url.ts";
const DEV_PELE_SCRIPT_PATH = "/@openclaw/pele.min.js";

function resolvePeleScriptEntry(): string {
  return fileURLToPath(new URL("./src/pele.min.ts", import.meta.url));
}

async function buildDevPeleScript(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "error",
    plugins: [peleClassicBundlePlugin()],
    build: {
      write: false,
      minify: true,
      lib: {
        entry: resolvePeleScriptEntry(),
        name: "OpenClawPele",
        formats: ["iife"],
      },
    },
  });
  const builds = Array.isArray(result) ? result : "output" in result ? [result] : [];
  if (builds.length === 0) {
    throw new Error("Vite started a watcher instead of building the Pele classic script.");
  }
  const outputs = builds.flatMap((entry) => entry.output);
  const script = outputs.find((entry) => entry.type === "chunk" && entry.isEntry);
  if (!script || script.type !== "chunk") {
    throw new Error("Vite did not emit the Pele classic script.");
  }
  return script.code;
}

export function peleClassicBundlePlugin(): Plugin {
  let command: "build" | "serve";
  let devScript: Promise<string> | undefined;
  let emitBrowserNotices = false;
  return {
    name: "openclaw-pele-classic-bundle",
    enforce: "pre",
    configResolved(config) {
      command = config.command;
      // Native builds copy this same canonical notice into their offline document.
      // Worker/lib builds emit only the classic script, not another notice copy.
      emitBrowserNotices = command === "build" && !config.isWorker && !config.build.lib;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== DEV_PELE_SCRIPT_PATH) {
          next();
          return;
        }
        devScript ??= buildDevPeleScript();
        void devScript
          .then((script) => {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/javascript; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(script);
          })
          .catch(next);
      });
    },
    async generateBundle() {
      if (emitBrowserNotices) {
        this.emitFile({
          type: "asset",
          fileName: "diagram-NOTICE.txt",
          source: await readFile(new URL("./native/NOTICE.txt", import.meta.url), "utf8"),
        });
      }
    },
    load(id) {
      const normalizedId = id.replaceAll("\\", "/");
      if (normalizedId.endsWith(PELE_SCRIPT_URL_SUFFIX)) {
        if (command === "serve") {
          return `export default ${JSON.stringify(DEV_PELE_SCRIPT_PATH)};`;
        }
        const scriptEntry = resolvePeleScriptEntry();
        return `import url from ${JSON.stringify(`${scriptEntry}?worker&url`)}; export default url;`;
      }
      return null;
    },
  };
}
