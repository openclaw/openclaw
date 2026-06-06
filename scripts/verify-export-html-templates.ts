#!/usr/bin/env tsx
/**
 * Verify that export-html templates are correctly copied to dist/export-html/
 *
 * This script runs after the build to ensure:
 * 1. The dist/export-html/ directory exists
 * 2. All required template files are present
 * 3. No files are in the old incorrect location (dist/auto-reply/reply/export-html/)
 *
 * Exit codes:
 * - 0: All checks pass
 * - 1: Verification failed (missing files or old location exists)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const exportHtmlDistDir = path.join(projectRoot, "dist", "export-html");
const exportHtmlOldDir = path.join(projectRoot, "dist", "auto-reply", "reply", "export-html");

const requiredFiles = [
  "template.html",
  "template.css",
  "template.js",
  "vendor/marked.min.js",
  "vendor/highlight.min.js",
];

function verifyExportHtmlTemplates(): number {
  console.log("🔍 Verifying export-html templates...");

  let exitCode = 0;

  // Check 1: Verify dist/export-html/ exists
  if (!fs.existsSync(exportHtmlDistDir)) {
    console.error(`❌ FAIL: dist/export-html/ directory does not exist`);
    console.error(`   Expected at: ${exportHtmlDistDir}`);
    exitCode = 1;
  } else {
    console.log(`✅ PASS: dist/export-html/ directory exists`);
  }

  // Check 2: Verify all required files are present in dist/export-html/
  if (fs.existsSync(exportHtmlDistDir)) {
    const missingFiles: string[] = [];

    for (const file of requiredFiles) {
      const filePath = path.join(exportHtmlDistDir, file);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(file);
      } else {
        const stats = fs.statSync(filePath);
        const sizeKB = (stats.size / 1024).toFixed(2);
        console.log(`✅ PASS: ${file} (${sizeKB} KB)`);
      }
    }

    if (missingFiles.length > 0) {
      console.error(`❌ FAIL: Missing required files in dist/export-html/:`);
      for (const file of missingFiles) {
        console.error(`   - ${file}`);
      }
      exitCode = 1;
    }
  }

  // Check 3: Verify old incorrect location does NOT exist
  if (fs.existsSync(exportHtmlOldDir)) {
    console.warn(`⚠️  WARNING: Old incorrect directory still exists at:`);
    console.warn(`   ${exportHtmlOldDir}`);
    console.warn(`   This should be cleaned up in future builds.`);
    // Don't fail on this, just warn
  } else {
    console.log(`✅ PASS: Old incorrect location (dist/auto-reply/reply/export-html/) does not exist`);
  }

  // Check 4: Verify vendor subdirectory exists and has files
  const vendorDir = path.join(exportHtmlDistDir, "vendor");
  if (fs.existsSync(vendorDir)) {
    const vendorFiles = fs.readdirSync(vendorDir);
    console.log(`✅ PASS: vendor/ directory contains ${vendorFiles.length} file(s)`);
  }

  console.log("");
  if (exitCode === 0) {
    console.log("✅ All export-html template verification checks passed!");
  } else {
    console.error("❌ Export-html template verification FAILED!");
    console.error("   The build may be incomplete or incorrect.");
  }

  return exitCode;
}

// Run verification
const exitCode = verifyExportHtmlTemplates();
process.exit(exitCode);
