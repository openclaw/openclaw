import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build, type Plugin } from "vite";
import controlUiViteConfig from "../ui/vite.config.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { "out-dir": { type: "string" } } });
if (!values["out-dir"]) {
  throw new Error("Provide --out-dir for a task-owned benchmark artifact directory");
}
const outDir = path.resolve(values["out-dir"]);
if (outDir === path.join(root, "dist/control-ui")) {
  throw new Error("The projection benchmark must not replace the shipping Control UI build");
}
await mkdir(outDir, { recursive: true });
if ((await readdir(outDir)).length !== 0) {
  throw new Error("Use an empty, task-owned directory for the projection benchmark");
}
const fixture = path.join(root, "ui/src/test-helpers/control-ui-projection-fixture.tsx");
const manifest: Plugin = {
  name: "control-ui-projection-benchmark-manifest",
  generateBundle(_options, bundle) {
    const entry = Object.values(bundle).find(
      (item) => item.type === "chunk" && item.facadeModuleId === fixture,
    );
    if (!entry || entry.type !== "chunk") {
      this.error("Projection benchmark entry was not emitted");
    }
    this.emitFile({
      type: "asset",
      fileName: "projection-fixture.json",
      source: JSON.stringify({ benchmarkOnly: true, entry: entry.fileName }),
    });
  },
};
const config = controlUiViteConfig({ outDir, command: "build" });
await build({
  ...config,
  configFile: false,
  root: path.join(root, "ui"),
  plugins: [...(config.plugins ?? []), manifest],
  build: {
    ...config.build,
    emptyOutDir: false,
    rolldownOptions: {
      ...config.build?.rolldownOptions,
      input: { main: path.join(root, "ui/index.html"), projectionFixture: fixture },
    },
  },
});

// Isolate new native resources from pre-existing shell singletons. This document is
// emitted only by the explicit benchmark build and imports no application entry.
const shippingHtml = await readFile(path.join(outDir, "index.html"), "utf8");
const styles = [...shippingHtml.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gu)]
  .map(([tag]) => tag.replace(/\smedia="print"/gu, ' media="all"'))
  .join("\n");
await writeFile(
  path.join(outDir, "instance-resource-fixture.html"),
  `<!doctype html><html lang="en" data-theme="light" data-theme-mode="light" data-theme-resolved="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic instance resources</title>${styles}</head><body></body></html>`,
);
