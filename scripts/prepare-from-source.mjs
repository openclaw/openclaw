#!/usr/bin/env node
// prepare-from-source.mjs — builds dist/ when installing from a git clone.
//
// npm git-install lifecycle: clone → npm install (deps) → prepare → prepack → pack.
// dist/ is gitignored so a fresh clone has no built artifacts. This script
// detects that situation and uses corepack+pnpm to install workspace deps and
// run the production build, so npm can then pack the result normally.
//
// When dist/ already exists (e.g. npm-registry install or dev build), this
// script exits immediately.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

if (existsSync(join(ROOT, "dist"))) {
  // Already built (dev checkout or registry install). Nothing to do.
  process.exit(0);
}

// We are in a git-clone context without a build. Use corepack pnpm to install
// workspace dependencies and run the full build.
console.log("[prepare] dist/ not found — building from source via corepack pnpm …");

function run(cmd) {
  console.log(`[prepare] $ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env } });
}

try {
  // Remove any partial node_modules that npm may have created. pnpm needs to
  // manage the dependency tree itself for the workspace to resolve correctly.
  run("rm -rf node_modules");

  // Install all workspace dependencies (dev + prod).
  run("corepack pnpm install --frozen-lockfile");

  // Produce dist/.
  run("corepack pnpm run build");
} catch (err) {
  console.error("[prepare] build from source failed:", err.message);
  process.exit(1);
}
