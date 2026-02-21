#!/usr/bin/env tsx
/**
 * Copy bundled Noto fonts from src/media/fonts to dist/fonts
 * (used by the table-image renderer for Unicode fallback glyphs).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const srcDir = path.join(projectRoot, "src", "media", "fonts");
const distDir = path.join(projectRoot, "dist", "fonts");

if (!fs.existsSync(srcDir)) {
  console.warn("[copy-table-fonts] Source directory not found:", srcDir);
  process.exit(0);
}

fs.mkdirSync(distDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith(".ttf") || file.endsWith(".otf")) {
    fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file));
    console.log(`[copy-table-fonts] Copied ${file}`);
  }
}
console.log("[copy-table-fonts] Done");
