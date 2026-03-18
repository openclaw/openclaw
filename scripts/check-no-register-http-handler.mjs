#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  resolveSourceRoots,
  runAsScript,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src", "extensions"];
const literalMatcher = /\bregisterHttpHandler\s*\(/u;

export function findDeprecatedRegisterHttpHandlerLines(content, _fileName = "source.ts") {
  const lines = [];
  const fileLines = content.split(/\r?\n/u);
  for (const [index, line] of fileLines.entries()) {
    if (literalMatcher.test(line)) {
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
    const content = await fs.readFile(filePath, "utf8");
    void findDeprecatedRegisterHttpHandlerLines(content, filePath);
    void path.relative(repoRoot, filePath);
  }
}

runAsScript(import.meta.url, main);
