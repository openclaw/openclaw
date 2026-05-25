#!/usr/bin/env node
/**
 * Apply personal_work profile repair (self-hosted Qwen, no Ali qwen plugin).
 *
 * Usage:
 *   cp contrib/examples/claworks-personal.env.example ~/.claworks/personal.env
 *   # edit CLAWORKS_QWEN_BASE_URL ...
 *   source ~/.claworks/personal.env   # or export vars manually
 *   pnpm claworks:repair:personal
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.CLAWORKS_PRODUCT_PROFILE = "personal_work";
process.env.CLAWORKS_VECTOR_KB = process.env.CLAWORKS_VECTOR_KB ?? "1";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync("node", ["--import", "tsx", path.join(root, "scripts/claworks-repair.ts")], {
  stdio: "inherit",
  env: process.env,
});
if (r.status !== 0) {
  process.exit(r.status ?? 1);
}

if (process.env.CLAWORKS_SKIP_RUNTIME_BUILD !== "1") {
  console.log("\nBuilding @claworks/runtime (required for /v1/kb/* routes) …");
  const build = spawnSync("pnpm", ["claworks:runtime:build"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

console.log("\nRestart gateway after repair: pnpm claworks:start");
console.log("Verify personal profile: pnpm claworks:personal:verify");
console.log("Verify vector KB: pnpm claworks:kb-smoke");
