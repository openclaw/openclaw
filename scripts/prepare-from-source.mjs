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

// Prevent infinite recursion: pnpm install → prepare → pnpm install → prepare …
if (process.env.GEMMACLAW_PREPARING === "1") {
  process.exit(0);
}

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
  execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env, GEMMACLAW_PREPARING: "1" } });
}

const pnpmVersion = detectPnpmVersion(ROOT);

// Resolve a working pnpm command. Prefer corepack (ships with Node 22+)
// because it doesn't modify npm's global state. Running `npm install -g pnpm`
// inside npm's git-install lifecycle corrupts the outer install (ENOENT on
// transitive dep install scripts like sharp).
let pnpmRunner;
if (hasCmd("pnpm")) {
  pnpmRunner = "pnpm";
} else if (hasCmd("corepack")) {
  // Enable corepack so pnpm shims land on PATH. Build scripts like
  // tsdown-build.mjs resolve pnpm via resolvePnpmRunner() which expects
  // a bare `pnpm` command. corepack enable creates the shim in the same
  // directory as node/npm, which is already on PATH.
  console.log("[prepare] pnpm not found, enabling via corepack…");
  try {
    run("corepack enable");
    pnpmRunner = "pnpm";
  } catch {
    // corepack enable failed (permissions?), use corepack pnpm directly.
    pnpmRunner = "corepack pnpm";
  }
} else {
  // No corepack (Node < 22 or stripped). Fall back to global npm install.
  try {
    console.log(`[prepare] pnpm not found, installing pnpm@${pnpmVersion} globally via npm…`);
    run(`npm install -g pnpm@${pnpmVersion}`);
    pnpmRunner = "pnpm";
  } catch {
    console.error("[prepare] cannot install pnpm. Install pnpm globally and retry.");
    process.exit(1);
  }
}

try {
  // Remove any partial node_modules that npm may have created. pnpm needs to
  // manage the dependency tree itself for the workspace to resolve correctly.
  run("rm -rf node_modules");

  // Install all workspace dependencies (dev + prod).
  run(`${pnpmRunner} install --frozen-lockfile`);

  // Produce dist/ using the gitInstall profile. The full build profile includes
  // runtime-postbuild which tries a nested `npm install` for bundled plugin deps
  // — that fails inside npm's git-clone lifecycle context. The gitInstall profile
  // builds only what the CLI needs (tsdown + build-stamp).
  run("node scripts/build-all.mjs gitInstall");

  // Note: do NOT rm -rf node_modules here. npm keeps internal references to
  // node_modules/.bin PATH entries during the git-install lifecycle. Deleting
  // the directory corrupts npm's child_process.spawn, causing ENOENT errors
  // for all subsequent install scripts (sharp, koffi, etc.). The tarball
  // produced by npm pack excludes node_modules by default, so leaving it
  // has no effect on the published package size.
} catch (err) {
  console.error("[prepare] build from source failed:", err.message);
  process.exit(1);
}
