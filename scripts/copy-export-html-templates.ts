#!/usr/bin/env tsx
/**
 * Copy export-html templates from src to dist
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const srcDir = path.join(projectRoot, "src", "auto-reply", "reply", "export-html");
const distDir = path.join(projectRoot, "dist", "export-html");

function copyExportHtmlTemplates() {
  if (!fs.existsSync(srcDir)) {
    console.warn("[copy-export-html-templates] Source directory not found:", srcDir);
    return;
  }

  // Create dist directory
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Copy main template files
  const templateFiles = ["template.html", "template.css", "template.js"];
  for (const file of templateFiles) {
    const srcFile = path.join(srcDir, file);
    const distFile = path.join(distDir, file);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, distFile);
      console.log(`[copy-export-html-templates] Copied ${file}`);
    }
  }

  // Copy vendor files
  const srcVendor = path.join(srcDir, "vendor");
  const distVendor = path.join(distDir, "vendor");
  if (fs.existsSync(srcVendor)) {
    if (!fs.existsSync(distVendor)) {
      fs.mkdirSync(distVendor, { recursive: true });
    }
    const vendorFiles = fs.readdirSync(srcVendor);
    for (const file of vendorFiles) {
      const srcFile = path.join(srcVendor, file);
      const distFile = path.join(distVendor, file);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, distFile);
        console.log(`[copy-export-html-templates] Copied vendor/${file}`);
      }
    }
  }

  console.log("[copy-export-html-templates] Done");
}

copyExportHtmlTemplates();
