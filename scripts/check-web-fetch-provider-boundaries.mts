#!/usr/bin/env node

import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { collectSourceFileContents } from "./lib/source-file-scan-cache.mts";
import { runAsScript } from "./lib/ts-guard-utils.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const scanExtensions = new Set([".ts", ".js", ".mjs", ".cjs"]);
const ignoredDirNames = new Set([
  ".artifacts",
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "extensions",
  "node_modules",
]);
const allowedFiles = new Set([
  "src/agents/tools/web-fetch.test-harness.ts",
  "src/config/legacy-web-fetch.ts",
  "src/config/zod-schema.agent-runtime.ts",
  "src/secrets/target-registry-data.ts",
]);
const suspiciousPatterns = [
  /fetchFirecrawlContent/,
  /firecrawl-fetch-provider\.js/,
  /createFirecrawlWebFetchProvider/,
  /providerId:\s*"firecrawl"/,
  /provider:\s*"firecrawl"/,
  /id:\s*"firecrawl"/,
];

async function main() {
  const violations = [];
  const files = await collectSourceFileContents({
    repoRoot,
    scanRoots: ["src"],
    scanExtensions,
    ignoredDirNames,
  });
  for (const { relativeFile, content } of files) {
    if (
      allowedFiles.has(relativeFile) ||
      relativeFile.includes(".test.") ||
      relativeFile.includes("test-support")
    ) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.includes("firecrawl") && !line.includes("Firecrawl")) {
        continue;
      }
      if (!suspiciousPatterns.some((pattern) => pattern.test(line))) {
        continue;
      }
      violations.push({
        file: relativeFile,
        line: index + 1,
        reason: "core web-fetch runtime/tooling contains Firecrawl-specific fetch logic",
      });
    }
  }
  for (const violation of violations.toSorted(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  )) {
    process.stderr.write(`${violation.file}:${violation.line} ${violation.reason}\n`);
  }
  if (violations.length > 0) {
    process.exit(1);
  }
  return 0;
}

runAsScript(import.meta.url, main);
