#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "extensions")];

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
    if (!entry.isFile() || !entryPath.endsWith(".ts") || isTestLikeFile(entryPath)) {
      continue;
    }
    out.push(entryPath);
  }
  return out;
}

function toLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function getPropertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function isUndefinedLikeExpression(node) {
  if (ts.isIdentifier(node) && node.text === "undefined") {
    return true;
  }
  return node.kind === ts.SyntaxKind.NullKeyword;
}

function hasRequiredAccountIdProperty(node) {
  if (!ts.isObjectLiteralExpression(node)) {
    return false;
  }
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "accountId") {
      return true;
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (getPropertyNameText(property.name) !== "accountId") {
      continue;
    }
    if (isUndefinedLikeExpression(property.initializer)) {
      return false;
    }
    return true;
  }
  return false;
}

function findViolations(content, filePath) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callName = node.expression.text;
      if (callName === "readChannelAllowFromStore") {
        if (node.arguments.length < 3 || isUndefinedLikeExpression(node.arguments[2])) {
          violations.push({
            line: toLine(sourceFile, node),
            reason: "readChannelAllowFromStore call must pass explicit accountId as 3rd arg",
          });
        }
      } else if (
        callName === "readLegacyChannelAllowFromStore" ||
        callName === "readLegacyChannelAllowFromStoreSync"
      ) {
        violations.push({
          line: toLine(sourceFile, node),
          reason: `${callName} is legacy-only; use account-scoped readChannelAllowFromStore* APIs`,
        });
      } else if (callName === "upsertChannelPairingRequest") {
        const firstArg = node.arguments[0];
        if (!firstArg || !hasRequiredAccountIdProperty(firstArg)) {
          violations.push({
            line: toLine(sourceFile, node),
            reason: "upsertChannelPairingRequest call must include accountId in params",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

async function main() {
  const files = (
    await Promise.all(sourceRoots.map(async (root) => await collectTypeScriptFiles(root)))
  ).flat();
  const violations = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    const fileViolations = findViolations(content, filePath);
    for (const violation of fileViolations) {
      violations.push({
        path: path.relative(repoRoot, filePath),
        ...violation,
      });
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error("Found unscoped pairing-store calls:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line} (${violation.reason})`);
  }
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
