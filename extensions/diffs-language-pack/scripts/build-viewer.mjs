#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(pluginRoot, "assets", "viewer-runtime.js");

await fs.mkdir(path.dirname(outputPath), { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(pluginRoot, "..", "diffs", "src", "viewer-client.ts")],
  target: "browser",
  format: "esm",
  minify: true,
  outdir: path.dirname(outputPath),
  naming: path.basename(outputPath),
  write: true,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log.message);
  }
  process.exit(1);
}

const runtime = await fs.readFile(outputPath, "utf8");
const minified = await transform(runtime, {
  format: "esm",
  legalComments: "none",
  loader: "js",
  minify: true,
  target: "es2020",
});
await fs.writeFile(outputPath, minified.code.replace(/[ \t]+$/gm, ""));
