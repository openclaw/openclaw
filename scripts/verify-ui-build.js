#!/usr/bin/env node
/**
 * Verifies that Control UI assets are present after build.
 * This script is called during prepack to ensure the UI was built successfully.
 *
 * Fails the build if required UI files are missing, preventing broken releases.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const controlUiDir = path.join(repoRoot, "dist", "control-ui");

const REQUIRED_FILES = ["index.html"];

const REQUIRED_DIRS = ["assets"];

function verifyUiBuild() {
  console.log("🔍 Verifying Control UI build...");

  let hasErrors = false;

  // Check if dist/control-ui directory exists
  if (!fs.existsSync(controlUiDir)) {
    console.error(`❌ Control UI directory not found: ${controlUiDir}`);
    console.error("");
    console.error("This usually means the UI build failed or was skipped.");
    console.error("To fix:");
    console.error("  1. Ensure pnpm is installed: npm install -g pnpm");
    console.error("  2. Run UI build manually: pnpm ui:build");
    console.error("  3. Then retry: npm publish or pnpm publish");
    console.error("");
    hasErrors = true;
  } else {
    console.log(`✅ Control UI directory exists: ${controlUiDir}`);

    // Check required files
    for (const file of REQUIRED_FILES) {
      const filePath = path.join(controlUiDir, file);
      if (!fs.existsSync(filePath)) {
        console.error(`❌ Required file missing: ${file}`);
        hasErrors = true;
      } else {
        console.log(`✅ Required file present: ${file}`);
      }
    }

    // Check required directories
    for (const dir of REQUIRED_DIRS) {
      const dirPath = path.join(controlUiDir, dir);
      if (!fs.existsSync(dirPath)) {
        console.error(`❌ Required directory missing: ${dir}/`);
        hasErrors = true;
      } else {
        const files = fs.readdirSync(dirPath);
        console.log(`✅ Required directory present: ${dir}/ (${files.length} files)`);
      }
    }
  }

  // Check required scripts (needed for manual UI build workaround)
  const REQUIRED_SCRIPTS = ["scripts/ui.js"];
  for (const script of REQUIRED_SCRIPTS) {
    const scriptPath = path.join(repoRoot, script);
    if (!fs.existsSync(scriptPath)) {
      console.error(`❌ Required script missing: ${script}`);
      console.error("   This script is needed for 'pnpm ui:build' workaround.");
      hasErrors = true;
    } else {
      console.log(`✅ Required script present: ${script}`);
    }
  }

  if (hasErrors) {
    console.error("");
    console.error("❌ Control UI verification FAILED");
    console.error("");
    console.error("The npm package would be published without Control UI assets.");
    console.error("This would break the web dashboard for all users.");
    console.error("");
    console.error("Please fix the issues above and retry.");
    process.exit(1);
  }

  console.log("");
  console.log("✅ Control UI verification PASSED");
  console.log("The package is ready for publishing.");
}

verifyUiBuild();
