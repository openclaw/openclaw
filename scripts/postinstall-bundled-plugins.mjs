#!/usr/bin/env node
// Runs after `npm i -g` to install runtime deps for bundled extensions
// that cannot be pre-bundled (e.g. platform-specific binaries like acpx).
// All other extension deps are already bundled into dist/ JS files.
// This script is a no-op outside of a global npm install context.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const isGlobal = process.env.npm_config_global === "true";
if (!isGlobal) {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionsDir = join(__dirname, "..", "dist", "extensions");

// Extensions whose runtime deps include platform-specific binaries and therefore
// cannot be pre-bundled. Add entries here if new extensions share this pattern.
const NEEDS_INSTALL = ["acpx"];

for (const ext of NEEDS_INSTALL) {
  const extDir = join(extensionsDir, ext);
  if (!existsSync(join(extDir, "package.json"))) {
    continue;
  }
  // Skip if already installed (node_modules/.bin present).
  if (existsSync(join(extDir, "node_modules", ".bin"))) {
    continue;
  }
  try {
    execSync("npm install --omit=dev --no-save --package-lock=false", {
      cwd: extDir,
      stdio: "pipe",
    });
    console.log(`[postinstall] installed bundled plugin deps: ${ext}`);
  } catch (e) {
    // Non-fatal: gateway will surface the missing dep via doctor.
    console.warn(`[postinstall] could not install deps for ${ext}: ${String(e)}`);
  }
}
