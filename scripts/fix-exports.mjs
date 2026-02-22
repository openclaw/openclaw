#!/usr/bin/env node
/**
 * Post-build fix for rolldown unbundle export-pruning bug.
 * Scans dist/ and restores exports that exist in src/ but were
 * tree-shaken from the compiled output.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";

const distDir = join(import.meta.dirname, "..", "dist");
const srcDir = join(import.meta.dirname, "..", "src");

function walkDir(dir) {
  let files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkDir(full));
    } else if (full.endsWith(".js") && !full.endsWith(".map")) {
      files.push(full);
    }
  }
  return files;
}

let fixes = 0;
for (const distFile of walkDir(distDir)) {
  const rel = relative(distDir, distFile);
  const srcFile = join(srcDir, rel.replace(/\.js$/, ".ts"));

  let srcContent;
  try {
    srcContent = readFileSync(srcFile, "utf8");
  } catch {
    continue;
  }

  const distContent = readFileSync(distFile, "utf8");

  // Find all named exports in source
  const srcExports = new Set();
  for (const m of srcContent.matchAll(
    /export\s+(?:function|const|let|var|class|async\s+function)\s+(\w+)/g,
  )) {
    srcExports.add(m[1]);
  }
  for (const m of srcContent.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (name) {
        srcExports.add(name);
      }
    }
  }

  // Find current dist export statement
  const exportMatch = distContent.match(/^export \{ (.+) \};$/m);
  if (!exportMatch) {
    continue;
  }

  const distExportEntries = exportMatch[1].split(",").map((s) => s.trim());
  const distExports = new Set(
    distExportEntries.map((s) => {
      const parts = s.trim().split(/\s+as\s+/);
      return parts[parts.length - 1].trim();
    }),
  );

  // Find functions/classes/consts defined in dist
  const distDefined = new Set();
  for (const m of distContent.matchAll(
    /^(?:function|const|let|var|class|async function)\s+(\w+)/gm,
  )) {
    distDefined.add(m[1]);
  }

  // Missing: in srcExports AND defined in dist but NOT in distExports
  const missing = [];
  for (const name of srcExports) {
    if (distDefined.has(name) && !distExports.has(name)) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    const allEntries = [...distExportEntries, ...missing];
    const newLine = "export { " + allEntries.join(", ") + " };";
    const fixed = distContent.replace(exportMatch[0], newLine);
    writeFileSync(distFile, fixed);
    fixes++;
  }
}
console.log(`[fix-exports] Restored missing exports in ${fixes} files`);
