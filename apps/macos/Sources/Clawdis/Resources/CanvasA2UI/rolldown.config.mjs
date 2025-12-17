import path from "node:path";
import { defineConfig } from "rolldown";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "../../../../../..");
const fromHere = (p) => path.resolve(here, p);

const a2uiLitDist = path.resolve(repoRoot, "vendor/a2ui/renderers/lit/dist/src");
const a2uiThemeContext = path.resolve(a2uiLitDist, "0.8/ui/context/theme.js");

export default defineConfig({
  input: fromHere("bootstrap.js"),
  treeshake: false,
  resolve: {
    alias: {
      "@a2ui/lit": path.resolve(a2uiLitDist, "index.js"),
      "@a2ui/lit/ui": path.resolve(a2uiLitDist, "0.8/ui/ui.js"),
      "@clawdis/a2ui-theme-context": a2uiThemeContext,
      "@lit/context": path.resolve(repoRoot, "node_modules/@lit/context/index.js"),
      "@lit/context/": path.resolve(repoRoot, "node_modules/@lit/context/"),
      "@lit-labs/signals": path.resolve(repoRoot, "node_modules/@lit-labs/signals/index.js"),
      "@lit-labs/signals/": path.resolve(repoRoot, "node_modules/@lit-labs/signals/"),
      lit: path.resolve(repoRoot, "node_modules/lit/index.js"),
      "lit/": path.resolve(repoRoot, "node_modules/lit/"),
    },
  },
  output: {
    file: fromHere("a2ui.bundle.js"),
    format: "esm",
    inlineDynamicImports: true,
    sourcemap: false,
  },
});
