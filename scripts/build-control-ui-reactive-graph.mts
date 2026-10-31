import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build, type Plugin, type PluginOption, type UserConfig } from "vite";

const virtualId = "virtual:openclaw-reactive-graph";
const resolvedId = `\0${virtualId}`;

// Isolated diagnostic build: never use its bytes or timings for production comparisons.
const { values } = parseArgs({ options: { "out-dir": { type: "string" } } });
if (!values["out-dir"]) {
  throw new Error("Provide --out-dir under .artifacts for this diagnostic-only build");
}
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = path.resolve(values["out-dir"]);
if (!outDir.startsWith(`${path.join(repoRoot, ".artifacts")}${path.sep}`)) {
  throw new Error("Reactive graph build output must be inside the checkout's .artifacts directory");
}
const uiRoot = path.join(repoRoot, "ui");
const requireUi = createRequire(path.join(uiRoot, "package.json"));
const { default: configFactory }: { default: (options: { outDir: string }) => UserConfig } =
  await import(pathToFileURL(path.join(uiRoot, "vite.config.ts")).href);
const solid = requireUi("@solidjs/vite-plugin").default;
const config = configFactory({ outDir });
const plugins: Plugin[] = [];
async function retainPlugins(input: PluginOption): Promise<void> {
  const resolved = await input;
  if (Array.isArray(resolved)) {
    for (const child of resolved) {
      await retainPlugins(child);
    }
  } else if (
    resolved &&
    resolved.name !== "solid" &&
    !resolved.name.startsWith("solid:") &&
    resolved.name !== "openclaw:solid-test-runtime" &&
    resolved.name !== "control-ui-precompressed-assets"
  ) {
    plugins.push(resolved);
  }
}
await retainPlugins(config.plugins);
const browserModule = fileURLToPath(
  new URL("./lib/control-ui-reactive-graph-browser.ts", import.meta.url),
);
const mainModule = path.join(uiRoot, "src/main.ts");
const probe: Plugin = {
  name: "openclaw-reactive-graph-benchmark",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === virtualId) {
      return resolvedId;
    }
    if (importer === resolvedId && source.startsWith("@solidjs/signals")) {
      return this.resolve(source, mainModule, { skipSelf: true });
    }
    return null;
  },
  load(id) {
    if (id !== resolvedId) {
      return null;
    }
    return `import { OBSERVE } from "@solidjs/signals";
import { attribution } from "@solidjs/signals/attribution";
import { installControlUiReactiveGraph } from ${JSON.stringify(browserModule)};
globalThis.__openclawReactiveGraph = installControlUiReactiveGraph(OBSERVE, attribution);`;
  },
  transform(source, id) {
    return id === mainModule ? `import ${JSON.stringify(virtualId)};\n${source}` : null;
  },
};
await build({
  ...config,
  configFile: false,
  root: uiRoot,
  plugins: [
    probe,
    solid({
      include: /\.[jt]sx$/u,
      dev: false,
      observe: true,
      hot: false,
      performanceTracks: false,
      diagnostics: false,
      solid: { sourceNames: true },
    }),
    ...plugins,
  ],
});
