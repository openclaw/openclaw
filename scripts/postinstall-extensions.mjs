#!/usr/bin/env node

// Postinstall hook: install runtime dependencies for bundled extensions.
//
// npm strips node_modules/ from published tarballs, so extensions that declare
// their own dependencies (e.g. acpx, diagnostics-otel) arrive without them
// after `npm i -g openclaw`. This script detects those extensions and runs
// `npm install --omit=dev` inside each one.
//
// Skipped in development (detected by the presence of pnpm-workspace.yaml or
// .git at the repo root) where pnpm workspace hoisting handles deps.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS_DIR = path.join(ROOT, "extensions");

// Skip in dev: workspace hoisting manages deps there.
if (
  fs.existsSync(path.join(ROOT, "pnpm-workspace.yaml")) ||
  fs.existsSync(path.join(ROOT, ".git"))
) {
  process.exit(0);
}

if (!fs.existsSync(EXTENSIONS_DIR)) {
  process.exit(0);
}

const extensions = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });

for (const entry of extensions) {
  if (!entry.isDirectory()) {
    continue;
  }

  const extDir = path.join(EXTENSIONS_DIR, entry.name);
  const pkgPath = path.join(extDir, "package.json");

  if (!fs.existsSync(pkgPath)) {
    continue;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }

  const deps = pkg.dependencies;
  if (!deps || Object.keys(deps).length === 0) {
    continue;
  }

  // Always run npm install; it is idempotent and fast when deps are satisfied,
  // and ensures stale deps from a previous install are updated on upgrade.
  console.log(`[postinstall] Installing dependencies for extension "${entry.name}"…`);
  try {
    // Use npm.cmd on Windows; strip inherited npm config so the child install
    // targets the extension directory instead of the global prefix.
    // npm_config_global and npm_config_location=global (npm v7+) both force
    // global mode; npm_config_prefix overrides the target directory.
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const env = { ...process.env };
    delete env.npm_config_global;
    delete env.npm_config_prefix;
    delete env.npm_config_location;
    execFileSync(npmBin, ["install", "--omit=dev", "--silent", "--no-audit", "--no-fund"], {
      cwd: extDir,
      stdio: "pipe",
      env,
    });
  } catch (err) {
    // Non-fatal: the extension's own ensure/startup logic may retry later.
    const stderr = err.stderr ? err.stderr.toString().trim() : "";
    console.warn(
      `[postinstall] WARNING: Failed to install deps for extension "${entry.name}": ${err.message}${stderr ? `\n${stderr}` : ""}`,
    );
  }
}
