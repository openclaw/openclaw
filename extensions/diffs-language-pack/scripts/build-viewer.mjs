#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginRoot, "../..");
const scriptPath = path.join(repoRoot, "scripts", "build-diffs-viewer-runtime.mjs");

const result = spawnSync(process.execPath, [scriptPath, "full"], {
  cwd: repoRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
