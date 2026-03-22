#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = path.join(repoRoot, "extensions");

const MODES = new Set([
  "src-outside-plugin-sdk",
  "plugin-sdk-internal",
  "relative-outside-package",
]);

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
  "relative-outside-package": path.join(
    repoRoot,
    "test",
    "fixtures",
    "extension-relative-outside-package-inventory.json",
  ),
};

let allInventoryByModePromise;
let parsedExtensionSourceFilesPromise;

const ruleTextByMode = {
  "src-outside-plugin-sdk":
    "Rule: production extensions/** must not import src/** outside src/plugin-sdk/**",
  "plugin-sdk-internal":
    "Rule: production extensions/** must not import src/plugin-sdk-internal/**",
  "relative-outside-package":
    "Rule: production extensions/** must not use relative imports that escape their own extension package root",
};

function normalizePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isCodeFile(fileName) {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(fileName);
}

function isTestLikeFile(relativePath) {
  return (
    /(^|\/)(__tests__|fixtures|test|tests)\//.test(relativePath) ||
    /(^|\/)[^/]*test-(support|helpers)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relativePath) ||
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

async function collectParsedExtensionSourceFiles() {
  if (!parsedExtensionSourceFilesPromise) {
    parsedExtensionSourceFilesPromise = (async () => {
      const files = await collectExtensionSourceFiles(extensionsRoot);
      return await Promise.all(
        files.map(async (filePath) => {
          const source = await fs.readFile(filePath, "utf8");
          const scriptKind =
            filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
              ? ts.ScriptKind.TSX
              : ts.ScriptKind.TS;
          return {
            filePath,
            sourceFile: ts.createSourceFile(
              filePath,
              source,
              ts.ScriptTarget.Latest,
              true,
              scriptKind,
            ),
          };
        }),
      );
    })();
  }
  return await parsedExtensionSourceFilesPromise;
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

function resolveExtensionRoot(filePath) {
  const relativePath = normalizePath(filePath);
  const segments = relativePath.split("/");
  if (segments[0] !== "extensions" || !segments[1]) {
    return null;
  }
  return `${segments[0]}/${segments[1]}`;
}

function classifyReason(mode, kind, resolvedPath, specifier) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (mode === "relative-outside-package") {
    if (resolvedPath?.startsWith("src/plugin-sdk/")) {
      return `${verb} plugin-sdk via relative path; use openclaw/plugin-sdk/<subpath>`;
    }
    if (resolvedPath?.startsWith("src/")) {
      return `${verb} core src path via relative path outside the extension package`;
    }
    if (resolvedPath?.startsWith("extensions/")) {
      return `${verb} another extension via relative path outside the extension package`;
    }
    return `${verb} relative path ${specifier} outside the extension package`;
  }
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
  if (mode === "relative-outside-package") {
    return false;
  }
  if (!resolvedPath?.startsWith("src/")) {
    return false;
  }
  if (mode === "plugin-sdk-internal") {
    return resolvedPath.startsWith("src/plugin-sdk-internal/");
  }
  return !resolvedPath.startsWith("src/plugin-sdk/");
}

function collectEntriesByModeFromSourceFile(sourceFile, filePath) {
  const entriesByMode = {
    "src-outside-plugin-sdk": [],
    "plugin-sdk-internal": [],
    "relative-outside-package": [],
  };
  const extensionRoot = resolveExtensionRoot(filePath);

  function push(kind, specifierNode, specifier) {
    const resolvedPath = resolveSpecifier(specifier, filePath);
    const baseEntry = {
      file: normalizePath(filePath),
      line: toLine(sourceFile, specifierNode),
      kind,
      specifier,
      resolvedPath,
    };

    if (specifier.startsWith(".") && resolvedPath && extensionRoot) {
      if (!(resolvedPath === extensionRoot || resolvedPath.startsWith(`${extensionRoot}/`))) {
        entriesByMode["relative-outside-package"].push({
          ...baseEntry,
          reason: classifyReason("relative-outside-package", kind, resolvedPath, specifier),
        });
      }
    }

    for (const mode of ["src-outside-plugin-sdk", "plugin-sdk-internal"]) {
      if (!shouldReport(mode, resolvedPath)) {
        continue;
      }
      entriesByMode[mode].push({
        ...baseEntry,
        reason: classifyReason(mode, kind, resolvedPath, specifier),
      });
    }
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
  return entriesByMode;
}

export async function collectExtensionPluginSdkBoundaryInventory(mode) {
  if (!MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  if (!allInventoryByModePromise) {
    allInventoryByModePromise = (async () => {
      const files = await collectParsedExtensionSourceFiles();
      const inventoryByMode = {
        "src-outside-plugin-sdk": [],
        "plugin-sdk-internal": [],
        "relative-outside-package": [],
      };
      for (const { filePath, sourceFile } of files) {
        const entriesByMode = collectEntriesByModeFromSourceFile(sourceFile, filePath);
        for (const inventoryMode of MODES) {
          inventoryByMode[inventoryMode].push(...entriesByMode[inventoryMode]);
        }
      }
      for (const inventoryMode of MODES) {
        inventoryByMode[inventoryMode] = inventoryByMode[inventoryMode].toSorted(compareEntries);
      }
      return inventoryByMode;
    })();
  }
  const inventoryByMode = await allInventoryByModePromise;
  return inventoryByMode[mode];
}

export async function readExpectedInventory(mode) {
  try {
    return JSON.parse(await fs.readFile(baselinePathByMode[mode], "utf8"));
  } catch (error) {
    if (
      (mode === "plugin-sdk-internal" ||
        mode === "src-outside-plugin-sdk" ||
        mode === "relative-outside-package") &&
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

function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

export async function runExtensionPluginSdkBoundaryCheck(argv = process.argv.slice(2), io) {
  const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = argv.includes("--json");
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "src-outside-plugin-sdk";
  if (!MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const actual = await collectExtensionPluginSdkBoundaryInventory(mode);
  if (json) {
    writeLine(streams.stdout, JSON.stringify(actual, null, 2));
    return 0;
  }

  writeLine(streams.stdout, formatInventoryHuman(mode, actual));
  if (mode === "relative-outside-package") {
    if (actual.length === 0) {
      return 0;
    }
    writeLine(
      streams.stderr,
      `Relative outside-package violations found (${actual.length}); this mode no longer uses a baseline.`,
    );
    return 1;
  }

  const expected = await readExpectedInventory(mode);
  const diff = diffInventory(expected, actual);
  if (diff.missing.length === 0 && diff.unexpected.length === 0) {
    writeLine(streams.stdout, `Baseline matches (${actual.length} entries).`);
    return 0;
  }
  if (diff.missing.length > 0) {
    writeLine(streams.stderr, `Missing baseline entries (${diff.missing.length}):`);
    for (const entry of diff.missing) {
      writeLine(streams.stderr, `  - ${entry.file}:${entry.line} ${entry.reason}`);
    }
  }
  if (diff.unexpected.length > 0) {
    writeLine(streams.stderr, `Unexpected inventory entries (${diff.unexpected.length}):`);
    for (const entry of diff.unexpected) {
      writeLine(streams.stderr, `  - ${entry.file}:${entry.line} ${entry.reason}`);
    }
  }
  return 1;
}

export async function main(argv = process.argv.slice(2), io) {
  const exitCode = await runExtensionPluginSdkBoundaryCheck(argv, io);
  if (!io) {
    process.exitCode = exitCode;
  }
  return exitCode;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
