#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = {
  curated: {
    entry: "extensions/diffs/src/viewer-client.ts",
    output: "extensions/diffs/assets/viewer-runtime.js",
    shikiAlias: "scripts/diffs-shiki-curated.ts",
  },
  full: {
    entry: "extensions/diffs/src/viewer-client.ts",
    output: "extensions/diffs-language-pack/assets/viewer-runtime.js",
  },
};

const targetName = process.argv[2];
const target = targets[targetName];
if (!target) {
  console.error(
    `Usage: node scripts/build-diffs-viewer-runtime.mjs ${Object.keys(targets).join("|")}`,
  );
  process.exit(1);
}

const outputPath = path.join(repoRoot, target.output);
await fs.mkdir(path.dirname(outputPath), { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, target.entry)],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  minify: true,
  legalComments: "none",
  outfile: outputPath,
  write: true,
  plugins: target.shikiAlias
    ? [
        {
          name: "openclaw-diffs-curated-shiki",
          setup(buildContext) {
            buildContext.onResolve({ filter: /^shiki$/ }, () => ({
              path: path.join(repoRoot, target.shikiAlias),
            }));
          },
        },
      ]
    : [],
});

const runtime = await fs.readFile(outputPath, "utf8");
await fs.writeFile(outputPath, runtime.replace(/[ \t]+$/gm, ""));
