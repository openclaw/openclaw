#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  collectTypeScriptFilesFromRoots,
  resolveSourceRoots,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = resolveSourceRoots(repoRoot, ["src/plugin-sdk", "src/plugins/runtime"]);

function normalizePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function compareEntries(left, right) {
  return (
    left.category.localeCompare(right.category) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.reason.localeCompare(right.reason)
  );
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

function pushEntry(entries, entry) {
  entries.push(entry);
}

function scanPluginSdkExtensionFacadeSmells(sourceFile, filePath) {
  const relativeFile = normalizePath(filePath);
  if (!relativeFile.startsWith("src/plugin-sdk/")) {
    return [];
  }

  const entries = [];

  function visit(node) {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const resolvedPath = resolveSpecifier(specifier, filePath);
      if (resolvedPath?.startsWith("extensions/")) {
        pushEntry(entries, {
          category: "plugin-sdk-extension-facade",
          file: relativeFile,
          line: toLine(sourceFile, node.moduleSpecifier),
          kind: "export",
          specifier,
          resolvedPath,
          reason: "plugin-sdk public surface re-exports extension-owned implementation",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return entries;
}

function scanRuntimeTypeImplementationSmells(sourceFile, filePath) {
  const relativeFile = normalizePath(filePath);
  if (!/^src\/plugins\/runtime\/types(?:-[^/]+)?\.ts$/.test(relativeFile)) {
    return [];
  }

  const entries = [];

  function visit(node) {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const specifier = node.argument.literal.text;
      const resolvedPath = resolveSpecifier(specifier, filePath);
      if (
        resolvedPath &&
        (/^src\/plugins\/runtime\/runtime-[^/]+\.ts$/.test(resolvedPath) ||
          /^extensions\/[^/]+\/runtime-api\.[^/]+$/.test(resolvedPath))
      ) {
        pushEntry(entries, {
          category: "runtime-type-implementation-edge",
          file: relativeFile,
          line: toLine(sourceFile, node.argument.literal),
          kind: "import-type",
          specifier,
          resolvedPath,
          reason: "runtime type file references implementation shim directly",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return entries;
}

function scanRuntimeServiceLocatorSmells(sourceFile, filePath) {
  const relativeFile = normalizePath(filePath);
  if (
    !relativeFile.startsWith("src/plugin-sdk/") &&
    !relativeFile.startsWith("src/plugins/runtime/")
  ) {
    return [];
  }

  const entries = [];
  const exportedNames = new Set();
  const runtimeStoreCalls = [];
  const mutableStateNodes = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const isExported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (isExported) {
        exportedNames.add(statement.name.text);
      }
    } else if (ts.isVariableStatement(statement)) {
      const isExported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isExported) {
          exportedNames.add(declaration.name.text);
        }
        if (
          !isExported &&
          (statement.declarationList.flags & ts.NodeFlags.Let) !== 0 &&
          ts.isIdentifier(declaration.name)
        ) {
          mutableStateNodes.push(declaration.name);
        }
      }
    }
  }

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createPluginRuntimeStore"
    ) {
      runtimeStoreCalls.push(node.expression);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const getterNames = [...exportedNames].filter((name) => /^get[A-Z]/.test(name));
  const setterNames = [...exportedNames].filter((name) => /^set[A-Z]/.test(name));

  if (runtimeStoreCalls.length > 0 && getterNames.length > 0 && setterNames.length > 0) {
    for (const callNode of runtimeStoreCalls) {
      pushEntry(entries, {
        category: "runtime-service-locator",
        file: relativeFile,
        line: toLine(sourceFile, callNode),
        kind: "runtime-store",
        specifier: "createPluginRuntimeStore",
        resolvedPath: relativeFile,
        reason: `exports paired runtime accessors (${getterNames.join(", ")} / ${setterNames.join(", ")}) over module-global store state`,
      });
    }
  }

  if (mutableStateNodes.length > 0 && getterNames.length > 0 && setterNames.length > 0) {
    for (const identifier of mutableStateNodes) {
      pushEntry(entries, {
        category: "runtime-service-locator",
        file: relativeFile,
        line: toLine(sourceFile, identifier),
        kind: "mutable-state",
        specifier: identifier.text,
        resolvedPath: relativeFile,
        reason: `module-global mutable state backs exported runtime accessors (${getterNames.join(", ")} / ${setterNames.join(", ")})`,
      });
    }
  }

  return entries;
}

export async function collectArchitectureSmells() {
  const files = (await collectTypeScriptFilesFromRoots(scanRoots)).toSorted((left, right) =>
    normalizePath(left).localeCompare(normalizePath(right)),
  );

  const inventory = [];
  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    inventory.push(...scanPluginSdkExtensionFacadeSmells(sourceFile, filePath));
    inventory.push(...scanRuntimeTypeImplementationSmells(sourceFile, filePath));
    inventory.push(...scanRuntimeServiceLocatorSmells(sourceFile, filePath));
  }

  return inventory.toSorted(compareEntries);
}

function formatInventoryHuman(inventory) {
  if (inventory.length === 0) {
    return "No architecture smells found for the configured checks.";
  }

  const lines = ["Architecture smell inventory:"];
  let activeCategory = "";
  let activeFile = "";
  for (const entry of inventory) {
    if (entry.category !== activeCategory) {
      activeCategory = entry.category;
      activeFile = "";
      lines.push(entry.category);
    }
    if (entry.file !== activeFile) {
      activeFile = entry.file;
      lines.push(`  ${activeFile}`);
    }
    lines.push(`    - line ${entry.line} [${entry.kind}] ${entry.reason}`);
    lines.push(`      specifier: ${entry.specifier}`);
    lines.push(`      resolved: ${entry.resolvedPath}`);
  }
  return lines.join("\n");
}

function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

export async function runArchitectureSmellsCheck(argv = process.argv.slice(2), io) {
  const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = argv.includes("--json");
  const inventory = await collectArchitectureSmells();

  if (json) {
    writeLine(streams.stdout, JSON.stringify(inventory, null, 2));
    return 0;
  }

  writeLine(streams.stdout, formatInventoryHuman(inventory));
  writeLine(streams.stdout, `${inventory.length} smell${inventory.length === 1 ? "" : "s"} found.`);
  return 0;
}

export async function main(argv = process.argv.slice(2), io) {
  return await runArchitectureSmellsCheck(argv, io);
}

runAsScript(import.meta.url, main);
