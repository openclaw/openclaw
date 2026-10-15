/** Bundle each Canvas A2UI dialect with its own renderer and catalog. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { transform } = require("@solidjs/compiler");
const outputFile = process.env.OPENCLAW_A2UI_BUNDLE_OUT
  ? path.resolve(process.env.OPENCLAW_A2UI_BUNDLE_OUT)
  : path.resolve(here, "..", "a2ui", "a2ui.bundle.js");
const outputV09File = process.env.OPENCLAW_A2UI_BUNDLE_OUT
  ? `${outputFile}.v0.9.js`
  : path.resolve(here, "..", "a2ui", "a2ui-v0.9.bundle.js");

const createConfig = (input, file) => ({
  input: path.resolve(here, input),
  platform: "browser",
  experimental: { attachDebugInfo: "none" },
  treeshake: false,
  plugins: [
    {
      name: "canvas-solid",
      transform(source, id) {
        if (!id.endsWith(".jsx")) {
          return null;
        }
        return {
          code: transform(source, {
            filename: id,
            generate: "dom",
            dev: false,
            sourceMap: false,
          }).code,
        };
      },
    },
  ],
  output: { file, format: "esm", codeSplitting: false, sourcemap: false },
});

export default [
  createConfig("bootstrap.jsx", outputFile),
  createConfig("bootstrap-v0.9.jsx", outputV09File),
];
