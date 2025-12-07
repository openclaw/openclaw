import path from "node:path";
import { defineConfig } from "rolldown";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "../../../../../..");
const fromRoot = (p) => path.resolve(here, p);

export default defineConfig({
  input: fromRoot("bootstrap.js"),
  treeshake: false,
  resolve: {
    alias: {
      "@mariozechner/pi-web-ui": fromRoot("index.js"),
      "@mariozechner/pi-ai": fromRoot("pi-ai-stub.js"),
      "@mariozechner/pi-ai/dist/utils/event-stream.js": fromRoot("pi-ai-stub.js"),
      "@mariozechner/pi-ai/dist/utils/json-parse.js": fromRoot("pi-ai-stub.js"),
      "@mariozechner/mini-lit": path.resolve(repoRoot, "node_modules/@mariozechner/mini-lit/dist/index.js"),
      "@mariozechner/mini-lit/": path.resolve(repoRoot, "node_modules/@mariozechner/mini-lit/"),
      "@mariozechner/mini-lit/dist/": path.resolve(repoRoot, "node_modules/@mariozechner/mini-lit/dist/"),
      lit: path.resolve(repoRoot, "node_modules/lit/index.js"),
      "lit/": path.resolve(repoRoot, "node_modules/lit/"),
      lucide: fromRoot("vendor/lucide/dist/esm/lucide.js"),
      "pdfjs-dist": fromRoot("vendor/pdfjs-dist/build/pdf.mjs"),
      "pdfjs-dist/": fromRoot("vendor/pdfjs-dist/"),
      "pdfjs-dist/build/pdf.worker.min.mjs": fromRoot("vendor/pdfjs-dist/build/pdf.worker.min.mjs"),
      "docx-preview": fromRoot("vendor/docx-preview/dist/docx-preview.mjs"),
      jszip: fromRoot("vendor/jszip/dist/jszip.min.js"),
      "highlight.js": fromRoot("vendor/highlight.js/es/index.js"),
      "@lmstudio/sdk": fromRoot("lmstudio-sdk-stub.js"),
      "ollama/browser": fromRoot("vendor/ollama/dist/browser.mjs"),
      "@sinclair/typebox": fromRoot("vendor/@sinclair/typebox/build/esm/index.mjs"),
      xlsx: fromRoot("vendor/xlsx/xlsx.mjs"),
      "whatwg-fetch": fromRoot("whatwg-fetch-stub.js"),
    },
  },
  output: {
    file: fromRoot("webchat.bundle.js"),
    format: "esm",
    inlineDynamicImports: true,
    sourcemap: false,
  },
});
