#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

function asPropertyAccess(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression;
  }
  if (typeof ts.isPropertyAccessChain === "function" && ts.isPropertyAccessChain(expression)) {
    return expression;
  }
  return null;
}

function isRawWindowOpenCall(expression) {
  const propertyAccess = asPropertyAccess(unwrapExpression(expression));
  if (!propertyAccess || propertyAccess.name.text !== "open") {
    return false;
  }

  const receiver = unwrapExpression(propertyAccess.expression);
  return (
    ts.isIdentifier(receiver) && (receiver.text === "window" || receiver.text === "globalThis")
  );
}

export function findRawWindowOpenLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const lines = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && isRawWindowOpenCall(node.expression)) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile)).line + 1;
      lines.push(line);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return lines;
}

export async function main() {
  const files = await collectTypeScriptFiles(uiSourceDir);
  const violations = [];

  for (const filePath of files) {
    if (allowedCallsites.has(filePath)) {
      continue;
    }

    const content = await fs.readFile(filePath, "utf8");
    for (const line of findRawWindowOpenLines(content, filePath)) {
      const relPath = path.relative(repoRoot, filePath);
      violations.push(`${relPath}:${line}`);
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
