import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { build } from "vite";

const MERMAID_CORE_SUFFIX = "/mermaid/dist/mermaid.core.mjs";
const MERMAID_LAYOUT_CHUNK = /\/mermaid\/dist\/chunks\/mermaid\.core\/chunk-[^/]+\.mjs$/u;
const MERMAID_SCRIPT_URL_SUFFIX = "/mermaid-renderer/src/mermaid-script-url.ts";
const DEV_MERMAID_SCRIPT_PATH = "/@openclaw/mermaid.min.js";

function resolveMermaidScriptEntry(): string {
  return fileURLToPath(new URL("./src/mermaid.min.ts", import.meta.url));
}

async function buildDevMermaidScript(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "error",
    plugins: [mermaidClassicBundlePlugin()],
    build: {
      write: false,
      minify: true,
      lib: {
        entry: resolveMermaidScriptEntry(),
        name: "OpenClawMermaid",
        formats: ["iife"],
      },
    },
  });
  const builds = Array.isArray(result) ? result : "output" in result ? [result] : [];
  if (builds.length === 0) {
    throw new Error("Vite started a watcher instead of building the Mermaid classic script.");
  }
  const outputs = builds.flatMap((entry) => entry.output);
  const script = outputs.find((entry) => entry.type === "chunk" && entry.isEntry);
  if (!script || script.type !== "chunk") {
    throw new Error("Vite did not emit the Mermaid classic script.");
  }
  return script.code;
}

export function mermaidClassicBundlePlugin(): Plugin {
  let command: "build" | "serve";
  let devScript: Promise<string> | undefined;
  return {
    name: "openclaw-mermaid-classic-bundle",
    enforce: "pre",
    configResolved(config) {
      command = config.command;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== DEV_MERMAID_SCRIPT_PATH) {
          next();
          return;
        }
        devScript ??= buildDevMermaidScript();
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
    async load(id) {
      const normalizedId = id.replaceAll("\\", "/");
      if (normalizedId.endsWith(MERMAID_SCRIPT_URL_SUFFIX)) {
        if (command === "serve") {
          return `export default ${JSON.stringify(DEV_MERMAID_SCRIPT_PATH)};`;
        }
        const scriptEntry = resolveMermaidScriptEntry();
        return `import url from ${JSON.stringify(`${scriptEntry}?worker&url`)}; export default url;`;
      }
      if (!normalizedId.endsWith(MERMAID_CORE_SUFFIX) && !MERMAID_LAYOUT_CHUNK.test(normalizedId)) {
        return null;
      }
      const source = await readFile(id.replace(/\?.*$/u, ""), "utf8");
      if (normalizedId.endsWith(MERMAID_CORE_SUFFIX)) {
        const withoutNewDiagrams = source
          .replace(
            "  registerLazyLoadedDiagrams(\n    afDetector_default,\n",
            "  registerLazyLoadedDiagrams(\n",
          )
          .replace(",\n    usecase\n  );", "\n  );");
        if (
          withoutNewDiagrams === source ||
          withoutNewDiagrams.includes("registerLazyLoadedDiagrams(\n    afDetector_default,") ||
          withoutNewDiagrams.includes(",\n    usecase\n  );")
        ) {
          throw new Error("Mermaid 12 legacy diagram registry contract changed.");
        }
        return withoutNewDiagrams;
      }
      if (!source.includes("elkLayoutLoaders")) {
        return null;
      }
      const withoutElk = source
        .replace(
          /import\("\.\/elk-[^"]+\.mjs"\)/u,
          'Promise.reject(new Error("ELK layout is unavailable."))',
        )
        .replace(/,\s*\.\.\.elkLayoutLoaders\(\)/u, "");
      if (
        withoutElk === source ||
        withoutElk.includes('import("./elk-') ||
        withoutElk.includes("...elkLayoutLoaders()")
      ) {
        throw new Error("Mermaid 12 ELK loader contract changed.");
      }
      return withoutElk;
    },
  };
}
