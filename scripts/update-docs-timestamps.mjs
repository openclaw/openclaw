#!/usr/bin/env node

/**
 * Update Mintlify doc timestamps in frontmatter
 *
 * Updates the `updated` field in markdown frontmatter to current date.
 * Run after doc changes to ensure timestamps reflect current content.
 *
 * Usage:
 *   node scripts/update-docs-timestamps.mjs [path]
 *
 * Examples:
 *   node scripts/update-docs-timestamps.mjs docs/operator1/
 *   node scripts/update-docs-timestamps.mjs docs/
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function formatDate(date = new Date()) {
  return date.toISOString().split("T")[0];
}

function updateDocTimestamp(filePath) {
  try {
    let content = fs.readFileSync(filePath, "utf-8");

    // Check if file has frontmatter
    if (!content.startsWith("---")) {
      return false;
    }

    // Extract frontmatter
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      return false;
    }

    const frontmatter = match[1];
    const today = formatDate();

    // Update or add the `updated` field
    let newFrontmatter;
    if (frontmatter.includes("updated:")) {
      newFrontmatter = frontmatter.replace(/updated:\s*"?[\d-]+"?/i, `updated: "${today}"`);
    } else {
      // Add after 'summary' or at the end of frontmatter
      if (frontmatter.includes("summary:")) {
        newFrontmatter = frontmatter.replace(/(summary:.*?\n)/, `$1updated: "${today}"\n`);
      } else {
        newFrontmatter = `${frontmatter.trimEnd()}\nupdated: "${today}"`;
      }
    }

    // Replace in full content
    const newContent = content.replace(/^---\n[\s\S]*?\n---/, `---\n${newFrontmatter}\n---`);

    if (newContent !== content) {
      fs.writeFileSync(filePath, newContent, "utf-8");
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Error processing ${filePath}:`, err.message);
    return false;
  }
}

function walkDocs(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    // Skip hidden files and common ignore patterns
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "zh-CN") {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...walkDocs(fullPath));
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) {
      files.push(fullPath);
    }
  }

  return files;
}

// Main
const targetPath = process.argv[2] || "docs/operator1";
const fullPath = path.resolve(rootDir, targetPath);

if (!fs.existsSync(fullPath)) {
  console.error(`❌ Path not found: ${fullPath}`);
  process.exit(1);
}

const isFile = fs.statSync(fullPath).isFile();
const filesToUpdate = isFile ? [fullPath] : walkDocs(fullPath);

console.log(`📝 Updating doc timestamps in ${targetPath}...`);

let updated = 0;
for (const file of filesToUpdate) {
  if (updateDocTimestamp(file)) {
    const relative = path.relative(rootDir, file);
    console.log(`   ✅ ${relative}`);
    updated++;
  }
}

console.log(`\n✨ Updated ${updated}/${filesToUpdate.length} files`);
