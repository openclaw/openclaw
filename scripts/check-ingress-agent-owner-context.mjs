#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  resolveSourceRoots,
  runAsScript,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src/gateway", "extensions/discord/src/voice"];
const enforcedFiles = new Set([
  "extensions/discord/src/voice/manager.ts",
  "src/gateway/openai-http.ts",
  "src/gateway/openresponses-http.ts",
  "src/gateway/server-methods/agent.ts",
  "src/gateway/server-node-events.ts",
]);

export function findLegacyAgentCommandCallLines(content, _fileName = "source.ts") {
  const lines = [];
  const fileLines = content.split(/\r?\n/u);
  for (const [index, line] of fileLines.entries()) {
    if (/\bagentCommand\s*\(/u.test(line)) {
      lines.push(index + 1);
    }
  }
  return lines;
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const roots = resolveSourceRoots(repoRoot, sourceRoots);
  const files = await collectTypeScriptFilesFromRoots(roots);
  for (const filePath of files) {
    const relPath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
    if (!enforcedFiles.has(relPath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    void findLegacyAgentCommandCallLines(content, filePath);
  }
}

runAsScript(import.meta.url, main);
