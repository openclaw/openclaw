#!/usr/bin/env node
/**
 * CI guardrail: ensure code outside the allowlist does not write directly to
 * the memory directory.  All memory writes should go through
 * `writeMemoryFileViaManager` (or `MemoryIndexManager.writeMemoryFile`) so the
 * index stays consistent.
 *
 * Usage:  bun scripts/check-memory-access.ts
 *         node --import tsx scripts/check-memory-access.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Files that are allowed to write to memory paths directly.
const ALLOWLIST = new Set([
  "src/memory/manager.ts",
  "src/memory/manager-sync-ops.ts",
  "src/memory/manager-embedding-ops.ts",
  "src/infra/fs-safe.ts",
]);

// Patterns that indicate a direct write targeting the memory directory.
// Matches things like:  writeFile(memoryDir  |  writeFile(memoryFilePath  |  writeFileWithinRoot({ rootDir: memoryDir
const WRITE_PATTERNS = [
  /writeFile\s*\(\s*memory/i,
  /writeFileSync\s*\(\s*memory/i,
  /writeFileWithinRoot\s*\(\s*\{[^}]*rootDir:\s*memory/i,
];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const srcDir = path.join(repoRoot, "src");
const violations: Array<{ file: string; line: number; text: string }> = [];

const files = [
  ...collectSourceFiles(srcDir),
  ...collectSourceFiles(path.join(repoRoot, "extensions")),
];

for (const filePath of files) {
  const rel = path.relative(repoRoot, filePath);
  if (ALLOWLIST.has(rel)) {
    continue;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of WRITE_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ file: rel, line: i + 1, text: line.trim() });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Direct memory directory writes found outside allowlist:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error(
    "\nUse writeMemoryFileViaManager() from src/memory/index.ts instead of direct fs writes.",
  );
  process.exit(1);
}

console.log("No direct memory directory writes outside allowlist.");
