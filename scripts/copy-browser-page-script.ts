#!/usr/bin/env tsx
/**
 * Copy page-script-enhanced.js next to emitted browser extension output (tsc/tsdown does not emit raw .js from src).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const src = path.join(
  projectRoot,
  "extensions",
  "browser",
  "src",
  "browser",
  "page-script-enhanced.js",
);

const destDirs = [
  path.join(projectRoot, "dist", "extensions", "browser", "src", "browser"),
  path.join(projectRoot, "dist", "browser"),
];

if (!fs.existsSync(src)) {
  throw new Error(`[copy-browser-page-script] Missing source: ${src}`);
}

for (const destDir of destDirs) {
  const dest = path.join(destDir, "page-script-enhanced.js");
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-browser-page-script] Copied -> ${dest}`);
}
