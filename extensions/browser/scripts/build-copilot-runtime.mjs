#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginDir, "../..");
const outfile = path.join(pluginDir, "chrome-extension", "modules", "copilot-runtime.js");

await build({
  entryPoints: [path.join(pluginDir, "scripts", "copilot-runtime-entry.ts")],
  outfile,
  bundle: true,
  format: "esm",
  legalComments: "inline",
  minify: true,
  platform: "browser",
  target: "chrome125",
  tsconfig: path.join(repoRoot, "tsconfig.json"),
});
