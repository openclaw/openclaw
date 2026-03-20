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
const scanRoots = resolveSourceRoots(repoRoot, ["src/plugins"]);
const baselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "plugin-extension-import-boundary-inventory.json",
);

const bundledWebSearchProviders = new Set([
  "brave",
  "firecrawl",
  "gemini",
  "grok",
  "kimi",
  "perplexity",
]);
const bundledWebSearchPluginIds = new Set([
  "brave",
  "firecrawl",
  "google",
  "moonshot",
  "perplexity",
  "xai",
]);

function normalizePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function compareEntries(left, right) {
  return (
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

function classifyResolvedExtensionReason(kind, resolvedPath) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (/^extensions\/[^/]+\/src\//.test(resolvedPath)) {
    return `${verb} extension implementation from src/plugins`;
  }
  if (/^extensions\/[^/]+\/index\.[^/]+$/.test(resolvedPath)) {
    return `${verb} extension entrypoint from src/plugins`;
  }
  return `${verb} extension-owned file from src/plugins`;
}

function pushEntry(entries, entry) {
  entries.push(entry);
}

function scanImportBoundaryViolations(sourceFile, filePath) {
  const entries = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolvedPath = resolveSpecifier(specifier, filePath);
      if (resolvedPath?.startsWith("extensions/")) {
        pushEntry(entries, {
          file: normalizePath(filePath),
          line: toLine(sourceFile, node.moduleSpecifier),
          kind: "import",
          specifier,
          resolvedPath,
          reason: classifyResolvedExtensionReason("import", resolvedPath),
        });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const resolvedPath = resolveSpecifier(specifier, filePath);
      if (resolvedPath?.startsWith("extensions/")) {
        pushEntry(entries, {
          file: normalizePath(filePath),
          line: toLine(sourceFile, node.moduleSpecifier),
          kind: "export",
          specifier,
          resolvedPath,
          reason: classifyResolvedExtensionReason("export", resolvedPath),
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      const resolvedPath = resolveSpecifier(specifier, filePath);
      if (resolvedPath?.startsWith("extensions/")) {
        pushEntry(entries, {
          file: normalizePath(filePath),
          line: toLine(sourceFile, node.arguments[0]),
          kind: "dynamic-import",
          specifier,
          resolvedPath,
          reason: classifyResolvedExtensionReason("dynamic-import", resolvedPath),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return entries;
}

function scanWebSearchRegistrySmells(sourceFile, filePath) {
  const relativeFile = normalizePath(filePath);
  if (relativeFile !== "src/plugins/web-search-providers.ts") {
    return [];
  }

  const entries = [];
  const lines = sourceFile.text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (line.includes("web-search-plugin-factory.js")) {
      pushEntry(entries, {
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: "../agents/tools/web-search-plugin-factory.js",
        resolvedPath: "src/agents/tools/web-search-plugin-factory.js",
        reason: "imports core-owned web search provider factory into plugin registry",
      });
    }

    const pluginMatch = line.match(/pluginId:\s*"([^"]+)"/);
    if (pluginMatch && bundledWebSearchPluginIds.has(pluginMatch[1])) {
      pushEntry(entries, {
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: pluginMatch[1],
        resolvedPath: relativeFile,
        reason: "hardcodes bundled web search plugin ownership in core registry",
      });
    }

    const providerMatch = line.match(/id:\s*"(brave|firecrawl|gemini|grok|kimi|perplexity)"/);
    if (providerMatch && bundledWebSearchProviders.has(providerMatch[1])) {
      pushEntry(entries, {
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: providerMatch[1],
        resolvedPath: relativeFile,
        reason: "hardcodes bundled web search provider metadata in core registry",
      });
    }
  }

  return entries;
}

function shouldSkipFile(filePath) {
  const relativeFile = normalizePath(filePath);
  return (
    relativeFile.startsWith("src/plugins/contracts/") ||
    /^src\/plugins\/runtime\/runtime-[^/]+-contract\.[cm]?[jt]s$/u.test(relativeFile)
  );
}

export async function collectPluginExtensionImportBoundaryInventory() {
  const files = (await collectTypeScriptFilesFromRoots(scanRoots))
    .filter((filePath) => !shouldSkipFile(filePath))
    .toSorted((left, right) => normalizePath(left).localeCompare(normalizePath(right)));

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
    inventory.push(...scanImportBoundaryViolations(sourceFile, filePath));
    inventory.push(...scanWebSearchRegistrySmells(sourceFile, filePath));
  }

  return inventory.toSorted(compareEntries);
}

export async function readExpectedInventory() {
  return JSON.parse(await fs.readFile(baselinePath, "utf8"));
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

function formatInventoryHuman(inventory) {
  if (inventory.length === 0) {
    return "Rule: src/plugins/** must not import extensions/**\nNo plugin import boundary violations found.";
  }

  const lines = [
    "Rule: src/plugins/** must not import extensions/**",
    "Plugin extension import boundary inventory:",
  ];
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

function formatEntry(entry) {
  return `${entry.file}:${entry.line} [${entry.kind}] ${entry.reason} (${entry.specifier} -> ${entry.resolvedPath})`;
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const actual = await collectPluginExtensionImportBoundaryInventory();
  const expected = await readExpectedInventory();
  const { missing, unexpected } = diffInventory(expected, actual);
  const matchesBaseline = missing.length === 0 && unexpected.length === 0;

  if (json) {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
  } else {
    console.log(formatInventoryHuman(actual));
    console.log(
      matchesBaseline
        ? `Baseline matches (${actual.length} entries).`
        : `Baseline mismatch (${unexpected.length} unexpected, ${missing.length} missing).`,
    );
    if (!matchesBaseline) {
      if (unexpected.length > 0) {
        console.error("Unexpected entries:");
        for (const entry of unexpected) {
          console.error(`- ${formatEntry(entry)}`);
        }
      }
      if (missing.length > 0) {
        console.error("Missing baseline entries:");
        for (const entry of missing) {
          console.error(`- ${formatEntry(entry)}`);
        }
      }
    }
  }

  if (!matchesBaseline) {
    process.exit(1);
  }
}

runAsScript(import.meta.url, main);
