#!/usr/bin/env tsx
/** Copy bundled Noto fonts from src/media/fonts to dist/fonts. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src", "media", "fonts");
const distDir = path.join(root, "dist", "fonts");

function copyTableFonts() {
  if (!fs.existsSync(srcDir)) {
    console.warn("[copy-table-fonts] Source directory not found:", srcDir);
    return;
  }

  fs.mkdirSync(distDir, { recursive: true });
  for (const file of fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith(".ttf") || f.endsWith(".otf"))) {
    fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file));
  }
  console.log("[copy-table-fonts] Done");
}

copyTableFonts();
