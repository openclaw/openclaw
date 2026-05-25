#!/usr/bin/env node
/**
 * Dry-run root `claworks` npm publish — build dist, list tarball contents, no upload.
 *
 * Usage:
 *   pnpm claworks:publish:dry-run
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, cwd = root) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

console.log("[claworks:publish:dry-run] building dist…");
run("pnpm build");

const distIndex = join(root, "dist/index.js");
if (!existsSync(distIndex)) {
  console.error("[claworks:publish:dry-run] dist/index.js missing after build");
  process.exit(1);
}

console.log("\n[claworks:publish:dry-run] npm pack --dry-run (root package `claworks`)");
run("npm pack --dry-run");

console.log(
  "\n[claworks:publish:dry-run] done — npm publish blocked by policy (see docs/design/REBRAND-TO-CLAWORKS.md)",
);
