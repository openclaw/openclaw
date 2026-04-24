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

function detectPnpmVersion(rootDir) {
  try {
    // packageManager is like: "pnpm@10.33.0"
    // https://nodejs.org/api/packages.html#packagemanager
    // Keep a fallback because this runs in install/prepare contexts.
    const raw = execSync("node -p \"require('./package.json').packageManager||''\"", {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    const m = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)/u.exec(raw);
    return m ? m[1] : "10.33.0";
  } catch {
    return "10.33.0";
  }
}

function hasCmd(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

if (existsSync(join(ROOT, "dist"))) {
  // Already built (dev checkout or registry install). Nothing to do.
  process.exit(0);
}

// We are in a git-clone context without a build.
console.log("[prepare] dist/ not found — building from source …");

function run(cmd) {
  console.log(`[prepare] $ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env } });
}

const pnpmVersion = detectPnpmVersion(ROOT);
// Resolve pnpm: prefer global pnpm, then npx as fallback.
// "npm exec -y pkg -- cmd" fails in nested npm lifecycle contexts (the
// downloaded binary is not placed on PATH correctly), so we use npx which
// runs the binary directly without relying on PATH injection.
const pnpmRunner = hasCmd("pnpm") ? "pnpm" : `npx -y pnpm@${pnpmVersion}`;

try {
  // Remove any partial node_modules that npm may have created. pnpm needs to
  // manage the dependency tree itself for the workspace to resolve correctly.
  run("rm -rf node_modules");

  // Install all workspace dependencies (dev + prod).
  run(`${pnpmRunner} install --frozen-lockfile`);

  // Produce dist/.
  run(`${pnpmRunner} run build`);
} catch (err) {
  console.error("[prepare] build from source failed:", err.message);
  process.exit(1);
}
