#!/usr/bin/env node
/**
 * Postinstall script - verify binary is available for this platform
 */

import { existsSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PLATFORMS = {
  "darwin-arm64": "@tloncorp/tlon-skill-darwin-arm64",
  "darwin-x64": "@tloncorp/tlon-skill-darwin-x64",
  "linux-x64": "@tloncorp/tlon-skill-linux-x64",
  "linux-arm64": "@tloncorp/tlon-skill-linux-arm64",
};

const platform = process.platform;
const arch = process.arch;
const key = `${platform}-${arch}`;

const packageName = PLATFORMS[key];
if (!packageName) {
  console.warn(`[tlon-skill] Warning: No binary available for ${platform}-${arch}`);
  console.warn(`[tlon-skill] Supported platforms: ${Object.keys(PLATFORMS).join(", ")}`);
  process.exit(0); // Don't fail install
}

// Try to find and chmod the binary
function findBinary() {
  // Check local dev binary
  const localBin = join(__dirname, "..", "bin", "tlon");
  if (existsSync(localBin)) {
    return localBin;
  }

  // Check via require.resolve
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`);
    const binPath = join(dirname(pkgPath), "tlon");
    if (existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // Not found via require
  }

  // Check sibling node_modules
  const sibling = join(__dirname, "..", "..", packageName, "tlon");
  if (existsSync(sibling)) {
    return sibling;
  }

  return null;
}

const binaryPath = findBinary();

if (binaryPath) {
  try {
    chmodSync(binaryPath, 0o755);
    console.log(`[tlon-skill] Binary ready: ${binaryPath}`);
  } catch (err) {
    // chmod might fail on some filesystems, that's ok
    console.log(`[tlon-skill] Binary found: ${binaryPath}`);
  }
} else {
  console.warn(`[tlon-skill] Warning: Could not find binary for ${platform}-${arch}`);
  console.warn(`[tlon-skill] The ${packageName} package may not have installed correctly.`);
  console.warn(`[tlon-skill] Try: npm install ${packageName}`);
}
