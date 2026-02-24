#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const READ_CALL_RE = /\bfs\.(?:readFile|readFileSync)\s*\(/;

const TARGET_DIRS = ["src/memory", "src/agents/tools"];

const ALLOWLIST = new Set([
  "src/memory/internal.ts",
  "src/memory/manager-embedding-ops.ts",
  "src/memory/manager.ts",
  "src/memory/qmd-manager.ts",
  "src/memory/session-files.ts",
  "src/agents/tools/common.ts",
]);

function shouldScanFile(file) {
  return file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".e2e.test.ts");
}

function listTargetFiles() {
  const files = [];
  const stack = [...TARGET_DIRS];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) {
      continue;
    }
    const entries = fs.readdirSync(next, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.posix.join(next, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && shouldScanFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("*/")
  );
}

function findUnsafeReadLine(content) {
  const lines = content.split("\n");
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (!line || isCommentLine(line)) {
      continue;
    }
    if (READ_CALL_RE.test(line)) {
      return idx + 1;
    }
  }
  return null;
}

const violations = [];
for (const file of listTargetFiles()) {
  if (ALLOWLIST.has(file)) {
    continue;
  }
  const content = fs.readFileSync(file, "utf-8");
  const line = findUnsafeReadLine(content);
  if (line !== null) {
    violations.push(`${file}:${line}`);
  }
}

if (violations.length > 0) {
  console.error("Unsafe direct file reads detected. Use safeReadTextFile()/inspectTextContent().");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("safe-read guard: OK");
