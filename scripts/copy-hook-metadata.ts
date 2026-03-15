#!/usr/bin/env tsx
/**
 * Copy HOOK.md files from src/hooks/bundled to dist/hooks/bundled.
 * Must match resolveBundledHooksDir() in src/hooks/bundled-dir.ts (dir of bundled-dir.js + "bundled").
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const verbose = process.env.OPENCLAW_BUILD_VERBOSE === "1";

const srcBundled = path.join(projectRoot, "src", "hooks", "bundled");
const distBundled = path.join(projectRoot, "dist", "hooks", "bundled");

function copyHookMetadata() {
  if (!fs.existsSync(srcBundled)) {
    console.warn("[copy-hook-metadata] Source directory not found:", srcBundled);
    return;
  }

  if (!fs.existsSync(distBundled)) {
    fs.mkdirSync(distBundled, { recursive: true });
  }

  const entries = fs.readdirSync(srcBundled, { withFileTypes: true });
  let copiedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const hookName = entry.name;
    const srcHookDir = path.join(srcBundled, hookName);
    const distHookDir = path.join(distBundled, hookName);
    const srcHookMd = path.join(srcHookDir, "HOOK.md");
    const distHookMd = path.join(distHookDir, "HOOK.md");

    if (!fs.existsSync(srcHookMd)) {
      console.warn(`[copy-hook-metadata] No HOOK.md found for ${hookName}`);
      continue;
    }

    if (!fs.existsSync(distHookDir)) {
      fs.mkdirSync(distHookDir, { recursive: true });
    }

    fs.copyFileSync(srcHookMd, distHookMd);
    copiedCount += 1;
    if (verbose) {
      console.log(`[copy-hook-metadata] Copied ${hookName}/HOOK.md`);
    }
  }

  console.log(`[copy-hook-metadata] Copied ${copiedCount} hook metadata files.`);
}

copyHookMetadata();
