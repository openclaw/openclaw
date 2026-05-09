#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  runAsScript,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const sourceRoots = [path.join(repoRoot, "src")];

const allowedCompiledRawPaths = new Set([
  "src/infra/kysely-node-sqlite.ts",
  "src/infra/kysely-node-sqlite.test.ts",
]);

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function collectPatternViolations(content, pattern, message, allow = () => false) {
  const violations = [];
  for (const match of content.matchAll(pattern)) {
    if (allow(match)) {
      continue;
    }
    violations.push({
      line: lineNumberAt(content, match.index ?? 0),
      message,
    });
  }
  return violations;
}

function collectKyselyGuardrailViolations(content, relativePath) {
  const violations = [];
  const hasKyselyContext =
    /from\s+["']kysely["']/u.test(content) ||
    /from\s+["'][^"']*kysely-sync\.js["']/u.test(content) ||
    /\bgetNodeSqliteKysely\b/u.test(content);

  if (relativePath !== "src/infra/kysely-sync.ts") {
    violations.push(
      ...collectPatternViolations(
        content,
        /\bexecuteSqliteQuery(?:Sync|TakeFirstSync|TakeFirstOrThrowSync)\s*</gu,
        "sync helper row generic at call site; let Kysely infer builder result rows",
      ),
    );
  }

  violations.push(
    ...collectPatternViolations(
      content,
      /\bsql\s*</gu,
      "typed raw sql snippet needs a small helper or allowlist",
      (match) => {
        const fromMatch = content.slice(match.index ?? 0, (match.index ?? 0) + 160);
        return (
          relativePath === "src/infra/kysely-node-sqlite.test.ts" &&
          fromMatch.includes("pragma user_version")
        );
      },
    ),
  );

  violations.push(
    ...collectPatternViolations(
      content,
      /\bsql\.(?:ref|table|id|raw)\s*\(/gu,
      "raw identifier helper requires a closed-set validator and a local allowlist",
    ),
  );

  if (hasKyselyContext) {
    violations.push(
      ...collectPatternViolations(
        content,
        /\.\s*dynamic\b/gu,
        "Kysely dynamic refs bypass literal reference checking; use only behind closed unions",
      ),
    );
  }

  violations.push(
    ...collectPatternViolations(
      content,
      /\bCompiledQuery\.raw\s*\(/gu,
      "CompiledQuery.raw is only allowed in the native SQLite dialect/test boundary",
      () => allowedCompiledRawPaths.has(relativePath),
    ),
  );

  return violations;
}

export async function collectKyselyGuardrails() {
  const files = await collectTypeScriptFilesFromRoots(sourceRoots, { includeTests: true });
  const violations = [];
  for (const filePath of files) {
    const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
    const content = await fs.readFile(filePath, "utf8");
    for (const violation of collectKyselyGuardrailViolations(content, relativePath)) {
      violations.push({ path: relativePath, ...violation });
    }
  }
  return violations;
}

export async function main() {
  const violations = await collectKyselyGuardrails();
  if (violations.length === 0) {
    console.log("Kysely guardrails OK");
    return;
  }
  console.error("Kysely guardrail violations:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.message}`);
  }
  process.exit(1);
}

runAsScript(import.meta.url, main);
