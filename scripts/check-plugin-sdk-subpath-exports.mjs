#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  collectTypeScriptFilesFromRoots,
  resolveSourceRoots,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = resolveSourceRoots(repoRoot, ["src", "extensions", "scripts", "test"]);

function readPackageExports() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return new Set(
    Object.keys(packageJson.exports ?? {})
      .filter((key) => key.startsWith("./plugin-sdk/"))
      .map((key) => key.slice("./plugin-sdk/".length)),
  );
}

function readEntrypoints() {
  const entrypoints = JSON.parse(
    readFileSync(path.join(repoRoot, "scripts/lib/plugin-sdk-entrypoints.json"), "utf8"),
  );
  return new Set(entrypoints.filter((entry) => entry !== "index"));
}

function normalizePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function parsePluginSdkSubpath(specifier) {
  if (!specifier.startsWith("openclaw/plugin-sdk/")) {
    return null;
  }
  const subpath = specifier.slice("openclaw/plugin-sdk/".length);
  return subpath || null;
}

function compareEntries(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.subpath.localeCompare(right.subpath)
  );
}

async function collectViolations() {
  const entrypoints = readEntrypoints();
  const exports = readPackageExports();
  const files = (await collectTypeScriptFilesFromRoots(scanRoots, { includeTests: true })).toSorted(
    (left, right) => normalizePath(left).localeCompare(normalizePath(right)),
  );
  const violations = [];

  for (const filePath of files) {
    const sourceText = readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    function push(kind, specifierNode, specifier) {
      const subpath = parsePluginSdkSubpath(specifier);
      if (!subpath) {
        return;
      }

      const missingFrom = [];
      if (!entrypoints.has(subpath)) {
        missingFrom.push("scripts/lib/plugin-sdk-entrypoints.json");
      }
      if (!exports.has(subpath)) {
        missingFrom.push("package.json exports");
      }
      if (missingFrom.length === 0) {
        return;
      }

      violations.push({
        file: normalizePath(filePath),
        line: toLine(sourceFile, specifierNode),
        kind,
        specifier,
        subpath,
        missingFrom,
      });
    }

    function visit(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        push("import", node.moduleSpecifier, node.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        push("export", node.moduleSpecifier, node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        push("dynamic-import", node.arguments[0], node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations.toSorted(compareEntries);
}

async function main() {
  const violations = await collectViolations();
  if (violations.length === 0) {
    console.log("OK: all referenced openclaw/plugin-sdk/<subpath> imports are exported.");
    return;
  }

  console.error(
    "Rule: every referenced openclaw/plugin-sdk/<subpath> must exist in the public package exports.",
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} [${violation.kind}] ${violation.specifier} missing from ${violation.missingFrom.join(" and ")}`,
    );
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
