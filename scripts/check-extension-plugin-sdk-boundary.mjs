#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = path.join(repoRoot, "extensions");

const MODES = new Set(["src-outside-plugin-sdk", "plugin-sdk-internal"]);

const baselinePathByMode = {
  "src-outside-plugin-sdk": path.join(
    repoRoot,
    "test",
    "fixtures",
    "extension-src-outside-plugin-sdk-inventory.json",
  ),
  "plugin-sdk-internal": path.join(
    repoRoot,
    "test",
    "fixtures",
    "extension-plugin-sdk-internal-inventory.json",
  ),
};

const ruleTextByMode = {
  "src-outside-plugin-sdk":
    "Rule: production extensions/** must not import src/** outside src/plugin-sdk/**",
  "plugin-sdk-internal":
    "Rule: production extensions/** must not import src/plugin-sdk-internal/**",
};

function normalizePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isCodeFile(fileName) {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(fileName);
}

function isTestLikeFile(relativePath) {
  return (
    /(^|\/)(__tests__|fixtures)\//.test(relativePath) ||
    /(^|\/)[^/]*test-support\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relativePath) ||
    /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relativePath)
  );
}

async function collectExtensionSourceFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !isCodeFile(entry.name)) {
        continue;
      }
      const relativePath = normalizePath(fullPath);
      if (isTestLikeFile(relativePath)) {
        continue;
      }
      out.push(fullPath);
    }
  }
  await walk(rootDir);
  return out.toSorted((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

function toLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function resolveSpecifier(specifier, importerFile) {
  if (specifier.startsWith(".")) {
    return normalizePath(path.resolve(path.dirname(importerFile), specifier));
  }
  if (specifier.startsWith("/")) {
    return normalizePath(specifier);
  }
  return null;
}

function classifyReason(mode, kind, resolvedPath) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (mode === "plugin-sdk-internal") {
    return `${verb} src/plugin-sdk-internal from an extension`;
  }
  if (resolvedPath.startsWith("src/plugin-sdk/")) {
    return `${verb} allowed plugin-sdk path`;
  }
  return `${verb} core src path outside plugin-sdk from an extension`;
}

function compareEntries(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.resolvedPath.localeCompare(right.resolvedPath) ||
    left.reason.localeCompare(right.reason)
  );
}

function shouldReport(mode, resolvedPath) {
  if (!resolvedPath?.startsWith("src/")) {
    return false;
  }
  if (mode === "plugin-sdk-internal") {
    return resolvedPath.startsWith("src/plugin-sdk-internal/");
  }
  return !resolvedPath.startsWith("src/plugin-sdk/");
}

function collectFromSourceFile(mode, sourceFile, filePath) {
  const entries = [];

  function push(kind, specifierNode, specifier) {
    const resolvedPath = resolveSpecifier(specifier, filePath);
    if (!shouldReport(mode, resolvedPath)) {
      return;
    }
    entries.push({
      file: normalizePath(filePath),
      line: toLine(sourceFile, specifierNode),
      kind,
      specifier,
      resolvedPath,
      reason: classifyReason(mode, kind, resolvedPath),
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
  return entries;
}

export async function collectExtensionPluginSdkBoundaryInventory(mode) {
  if (!MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  const files = await collectExtensionSourceFiles(extensionsRoot);
  const inventory = [];
  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const scriptKind =
      filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    inventory.push(...collectFromSourceFile(mode, sourceFile, filePath));
  }
  return inventory.toSorted(compareEntries);
}

export async function readExpectedInventory(mode) {
  try {
    return JSON.parse(await fs.readFile(baselinePathByMode[mode], "utf8"));
  } catch (error) {
    if (
      (mode === "plugin-sdk-internal" || mode === "src-outside-plugin-sdk") &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

export function diffInventory(expected, actual) {
  const expectedKeys = new Set(expected.map((entry) => JSON.stringify(entry)));
  const actualKeys = new Set(actual.map((entry) => JSON.stringify(entry)));
  return {
    missing: expected
      .filter((entry) => !actualKeys.has(JSON.stringify(entry)))
      .toSorted(compareEntries),
    unexpected: actual
      .filter((entry) => !expectedKeys.has(JSON.stringify(entry)))
      .toSorted(compareEntries),
  };
}

function formatInventoryHuman(mode, inventory) {
  const lines = [ruleTextByMode[mode]];
  if (inventory.length === 0) {
    lines.push("No extension plugin-sdk boundary violations found.");
    return lines.join("\n");
  }
  lines.push("Extension boundary inventory:");
  let activeFile = "";
  for (const entry of inventory) {
    if (entry.file !== activeFile) {
      activeFile = entry.file;
      lines.push(activeFile);
    }
    lines.push(`  - line ${entry.line} [${entry.kind}] ${entry.reason}`);
    lines.push(`    specifier: ${entry.specifier}`);
    lines.push(`    resolved: ${entry.resolvedPath}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "src-outside-plugin-sdk";
  if (!MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const actual = await collectExtensionPluginSdkBoundaryInventory(mode);
  if (json) {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
    return;
  }

  const expected = await readExpectedInventory(mode);
  const diff = diffInventory(expected, actual);
  console.log(formatInventoryHuman(mode, actual));
  if (diff.missing.length === 0 && diff.unexpected.length === 0) {
    console.log(`Baseline matches (${actual.length} entries).`);
    return;
  }
  if (diff.missing.length > 0) {
    console.error(`Missing baseline entries (${diff.missing.length}):`);
    for (const entry of diff.missing) {
      console.error(`  - ${entry.file}:${entry.line} ${entry.reason}`);
    }
  }
  if (diff.unexpected.length > 0) {
    console.error(`Unexpected inventory entries (${diff.unexpected.length}):`);
    for (const entry of diff.unexpected) {
      console.error(`  - ${entry.file}:${entry.line} ${entry.reason}`);
    }
  }
  process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
