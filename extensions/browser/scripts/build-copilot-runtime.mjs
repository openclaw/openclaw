#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(pluginDir, "../..");
const outfile = path.join(pluginDir, "chrome-extension", "modules", "copilot-runtime.js");
const execFileAsync = promisify(execFile);

await build({
  entryPoints: [path.join(pluginDir, "scripts", "copilot-runtime-entry.ts")],
  outfile,
  bundle: true,
  format: "esm",
  legalComments: "inline",
  minify: true,
  platform: "browser",
  target: "chrome125",
});
await execFileAsync(process.execPath, [
  path.join(rootDir, "node_modules", "oxfmt", "bin", "oxfmt"),
  outfile,
]);
