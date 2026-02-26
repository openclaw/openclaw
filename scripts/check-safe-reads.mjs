#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const READ_CALL_RE = /\bfs\.(?:readFile|readFileSync)\s*\(/;

const TARGET_DIRS = ["src/memory", "src/agents/tools", "src/security"];

const ALLOWLIST = new Set([
  // src/memory — bulk file readers with established safe-read patterns
  "src/memory/internal.ts",
  "src/memory/manager-embedding-ops.ts",
  "src/memory/manager.ts",
  "src/memory/qmd-manager.ts",
  "src/memory/session-files.ts",
  // src/agents/tools
  "src/agents/tools/common.ts",
  "src/agents/tools/canvas-tool.ts", // reads canvas A2UI bundle at fixed dist path
  // src/security — files that read their own fixed-path data stores
  "src/security/safe-file-read.ts", // IS the safeReadTextFile implementation
  "src/security/vault-crypto.ts", // reads vault key at fixed OS-specific path
  "src/security/credential-vault.ts", // reads vault registry at fixed path
  "src/security/credential-audit.ts", // reads own JSONL audit log
  "src/security/security-events.ts", // reads own JSONL event store
  // src/security — files that read admin-configured or bounded paths
  "src/security/skill-scanner.ts", // reads skill files to scan them; already has size guard; using safeReadTextFile here would be circular
  "src/security/audit-extra.async.ts", // reads plugin package.json at admin-configured paths
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
