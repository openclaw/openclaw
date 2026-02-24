#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
  path.join(repoRoot, "src", "channels"),
  path.join(repoRoot, "src", "infra", "outbound"),
  path.join(repoRoot, "src", "line"),
  path.join(repoRoot, "src", "media-understanding"),
  path.join(repoRoot, "extensions"),
];
const allowedCallsites = new Set([path.join(repoRoot, "extensions", "feishu", "src", "dedup.ts")]);

function isTestLikeFile(filePath) {
  return (
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test-utils.ts") ||
    filePath.endsWith(".test-harness.ts") ||
    filePath.endsWith(".e2e-harness.ts")
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
    if (isTestLikeFile(entryPath)) {
      continue;
    }
    out.push(entryPath);
  }
  return out;
}

function collectNodeOsImports(sourceFile) {
  const osNamespaceOrDefault = new Set();
  const namedTmpdir = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (!statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (statement.moduleSpecifier.text !== "node:os") {
      continue;
    }
    const clause = statement.importClause;
    if (clause.name) {
      osNamespaceOrDefault.add(clause.name.text);
    }
    if (!clause.namedBindings) {
      continue;
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
      osNamespaceOrDefault.add(clause.namedBindings.name.text);
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === "tmpdir") {
        namedTmpdir.add(element.name.text);
      }
    }
  }
  return { osNamespaceOrDefault, namedTmpdir };
}

function unwrapExpression(expression) {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

export function findMessagingTmpdirCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const { osNamespaceOrDefault, namedTmpdir } = collectNodeOsImports(sourceFile);
  const lines = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "tmpdir" &&
        ts.isIdentifier(callee.expression) &&
        osNamespaceOrDefault.has(callee.expression.text)
      ) {
        const line = sourceFile.getLineAndCharacterOfPosition(callee.getStart(sourceFile)).line + 1;
        lines.push(line);
      } else if (ts.isIdentifier(callee) && namedTmpdir.has(callee.text)) {
        const line = sourceFile.getLineAndCharacterOfPosition(callee.getStart(sourceFile)).line + 1;
        lines.push(line);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return lines;
}

export async function main() {
  const files = (
    await Promise.all(sourceRoots.map(async (dir) => await collectTypeScriptFiles(dir)))
  ).flat();
  const violations = [];

  for (const filePath of files) {
    if (allowedCallsites.has(filePath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    for (const line of findMessagingTmpdirCallLines(content, filePath)) {
      violations.push(`${path.relative(repoRoot, filePath)}:${line}`);
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error("Found os.tmpdir()/tmpdir() usage in messaging/channel runtime sources:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error(
    "Use resolvePreferredOpenClawTmpDir() or plugin-sdk temp helpers instead of host tmp defaults.",
  );
  process.exit(1);
}

const isDirectExecution = (() => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(import.meta.url);
})();

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
