#!/usr/bin/env node
// Verifies each generated Control UI sidecar encodes the final emitted asset bytes.
import fs from "node:fs";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot: string = resolveRepoRoot(import.meta.url);
const outputDir = process.argv[2] ?? path.join(repoRoot, "dist/control-ui");
const assetsDir = path.join(outputDir, "assets");
const errors = [];
let checked = 0;

const sidecarPaths = [
  ...fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(assetsDir, entry.name)),
  ...["sw.js.br", "sw.js.gz"]
    .map((file) => path.join(outputDir, file))
    .filter((file) => fs.existsSync(file)),
];
for (const sidecarPath of sidecarPaths) {
  const suffix = sidecarPath.endsWith(".br") ? ".br" : sidecarPath.endsWith(".gz") ? ".gz" : null;
  if (!suffix) {
    continue;
  }
  const sourcePath = sidecarPath.slice(0, -suffix.length);
  try {
    const encoded = fs.readFileSync(sidecarPath);
    const decoded = suffix === ".br" ? brotliDecompressSync(encoded) : gunzipSync(encoded);
    const source = fs.readFileSync(sourcePath);
    if (!decoded.equals(source)) {
      errors.push(
        `${path.basename(sidecarPath)}: decoded bytes differ from ${path.basename(sourcePath)}`,
      );
    }
  } catch (error) {
    errors.push(
      `${path.basename(sidecarPath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  checked += 1;
}

if (checked === 0) {
  errors.push("no precompressed Control UI assets found");
}
if (errors.length > 0) {
  throw new Error(`Control UI precompressed asset verification failed:\n${errors.join("\n")}`);
}

process.stdout.write(`verified ${checked} finalized Control UI sidecars\n`);
