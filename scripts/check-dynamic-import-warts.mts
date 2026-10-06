#!/usr/bin/env node

// Advises on ineffective or suspicious dynamic import patterns.
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  collectFileViolations,
  runAsScript,
  toLine,
  visitModuleSpecifiers,
} from "./lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const defaultRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "extensions")];

type DynamicImportAdvisory = { line: number; reason: string };
type ImportLines = Map<string, [number, ...number[]]>;

function isTypeOnlyImportDeclaration(node: ts.ImportDeclaration) {
  const clause = node.importClause;
  return Boolean(
    clause &&
    (clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      (!clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly))),
  );
}

function isTypeOnlyExportDeclaration(node: ts.ExportDeclaration) {
  const clause = node.exportClause;
  return (
    node.isTypeOnly ||
    Boolean(
      clause &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly),
    )
  );
}

function isExecuteDeclaration(node: ts.Node) {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isVariableDeclaration(node) &&
    !ts.isPropertyAssignment(node)
  ) {
    return false;
  }
  const name = node.name;
  return Boolean(
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "execute",
  );
}

function isIgnoredTestHelperContent(content: string) {
  return /\bfrom\s+["']vitest["']/.test(content) || /\bfrom\s+["']@vitest\//.test(content);
}

function isIgnoredTestHelperPath(filePath: string) {
  const normalized = filePath.split(path.sep).join("/");
  const base = path.basename(filePath);
  return (
    normalized.includes("/test/") ||
    /(?:^|[./-])test(?:[./-]|$)/.test(base) ||
    base.includes("test-support") ||
    base.includes("test-harness") ||
    base.includes("test-helper") ||
    base.includes("test-mocks")
  );
}

export function findDynamicImportAdvisories(
  _content: string,
  _fileName: string,
  sourceFile: ts.SourceFile,
) {
  const staticRuntimeImports: ImportLines = new Map();
  const dynamicImports: ImportLines = new Map();
  const directExecuteImports: DynamicImportAdvisory[] = [];

  const addLine = (map: ImportLines, specifier: string, line: number) => {
    const lines = map.get(specifier);
    if (lines) {
      lines.push(line);
    } else {
      map.set(specifier, [line]);
    }
  };

  visitModuleSpecifiers(sourceFile, ({ kind, node, specifier }) => {
    if (
      (ts.isImportDeclaration(node) && !isTypeOnlyImportDeclaration(node)) ||
      (ts.isExportDeclaration(node) && !isTypeOnlyExportDeclaration(node))
    ) {
      addLine(staticRuntimeImports, specifier, toLine(sourceFile, node));
    }

    if (kind === "dynamic-import" && specifier) {
      const line = toLine(sourceFile, node);
      addLine(dynamicImports, specifier, line);
      let ancestor: ts.Node | undefined = node;
      while (ancestor && !isExecuteDeclaration(ancestor)) {
        ancestor = ancestor.parent;
      }
      if (ancestor) {
        directExecuteImports.push({
          line,
          reason: `direct dynamic import of "${specifier}" inside execute path; move it behind a cached loader`,
        });
      }
    }
  });

  const advisories = [...directExecuteImports];
  for (const [specifier, dynamicLines] of dynamicImports) {
    const staticLines = staticRuntimeImports.get(specifier);
    if (staticLines?.length) {
      advisories.push({
        line: dynamicLines[0],
        reason: `runtime static + dynamic import of "${specifier}" (static line ${staticLines[0]})`,
      });
    }
    if (dynamicLines.length > 1) {
      advisories.push({
        line: dynamicLines[0],
        reason: `repeated direct dynamic import of "${specifier}" (${dynamicLines.length} callsites: ${dynamicLines.join(", ")})`,
      });
    }
  }
  return advisories;
}

function collectDynamicImportAdvisories() {
  return collectFileViolations({
    repoRoot,
    sourceRoots: defaultRoots,
    extraTestSuffixes: [".suite.ts"],
    skipFile: isIgnoredTestHelperPath,
    findViolations: (content, filePath, sourceFile) =>
      isIgnoredTestHelperContent(content)
        ? []
        : findDynamicImportAdvisories(content, filePath, sourceFile),
  });
}

export async function main(argv = process.argv.slice(2)) {
  const fail = argv.includes("--fail");
  const json = argv.includes("--json");
  const advisories = await collectDynamicImportAdvisories();

  if (json) {
    console.log(JSON.stringify({ advisories }, null, 2));
  } else if (advisories.length === 0) {
    console.log("No dynamic import advisories found.");
  } else {
    console.log(`Dynamic import advisories (${advisories.length}):`);
    for (const advisory of advisories) {
      console.log(`- ${advisory.path}:${advisory.line} ${advisory.reason}`);
    }
    console.log("Advisory only. Use --fail when ratcheting this into a hard check.");
  }

  if (fail && advisories.length > 0) {
    process.exitCode = 1;
  }
}

runAsScript(import.meta.url, main);
