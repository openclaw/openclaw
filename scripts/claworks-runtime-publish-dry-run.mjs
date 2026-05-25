#!/usr/bin/env node
/**
 * Dry-run @claworks/runtime npm publish — build dist, list tarball contents, no upload.
 *
 * Usage:
 *   pnpm claworks:runtime:publish:dry-run
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "packages/claworks-runtime");

function run(cmd, cwd = root) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

console.log("[claworks:runtime:publish:dry-run] building dist…");
run("pnpm claworks:runtime:build");

const distIndex = join(pkgDir, "dist/index.mjs");
if (!existsSync(distIndex)) {
  console.error("[claworks:runtime:publish:dry-run] dist/index.mjs missing after build");
  process.exit(1);
}

console.log("\n[claworks:runtime:publish:dry-run] npm pack --dry-run");
run("npm pack --dry-run", pkgDir);

console.log(
  "\n[claworks:runtime:publish:dry-run] done — npm publish blocked by policy (see docs/design/REBRAND-TO-CLAWORKS.md)",
);
