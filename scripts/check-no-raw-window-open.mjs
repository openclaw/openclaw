#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiSourceDir = path.join(repoRoot, "ui", "src", "ui");
const allowedCallsites = new Set([path.join(uiSourceDir, "open-external-url.ts")]);

function isTestFile(filePath) {
  return (
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".browser.test.ts") ||
    filePath.endsWith(".node.test.ts")
  );
}

async function collectTypeScriptFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectTypeScriptFiles(entryPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entryPath.endsWith(".ts")) {
      continue;
    }
    if (isTestFile(entryPath)) {
      continue;
    }
    out.push(entryPath);
  }
  return out;
}

function lineNumberAt(content, index) {
  let lines = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) {
      lines++;
    }
  }
  return lines;
}

async function main() {
  const files = await collectTypeScriptFiles(uiSourceDir);
  const violations = [];
  const rawWindowOpenRe = /\bwindow\s*\.\s*open\s*\(/g;

  for (const filePath of files) {
    if (allowedCallsites.has(filePath)) {
      continue;
    }

    const content = await fs.readFile(filePath, "utf8");
    let match = rawWindowOpenRe.exec(content);
    while (match) {
      const line = lineNumberAt(content, match.index);
      const relPath = path.relative(repoRoot, filePath);
      violations.push(`${relPath}:${line}`);
      match = rawWindowOpenRe.exec(content);
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error("Found raw window.open usage outside safe helper:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error("Use openExternalUrlSafe(...) from ui/src/ui/open-external-url.ts instead.");
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
