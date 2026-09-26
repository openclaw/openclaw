#!/usr/bin/env node

// Blocks host-random tmpdir usage in messaging/channel runtime sources.
import * as ts from "typescript/unstable/ast";
import { runCallsiteGuard } from "./lib/callsite-guard.mts";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mts";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mts";

/**
 * Source roots scanned for unsafe messaging tmpdir usage.
 */
export const messagingTmpdirGuardSourceRoots = [
  "src/channels",
  "src/infra/outbound",
  "src/line",
  "src/media",
  "src/media-understanding",
  "extensions",
];
function collectOsTmpdirImports(sourceFile: ts.SourceFile) {
  const osModuleSpecifiers = new Set(["node:os", "os"]);
  const osNamespaceOrDefault = new Set<string>();
  const namedTmpdir = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (!statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!osModuleSpecifiers.has(statement.moduleSpecifier.text)) {
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

/**
 * Finds `os.tmpdir()` or imported `tmpdir()` call lines in source.
 */
export function findMessagingTmpdirCallLines(
  _content: string,
  _fileName: string,
  sourceFile: ts.SourceFile,
): number[] {
  const { osNamespaceOrDefault, namedTmpdir } = collectOsTmpdirImports(sourceFile);
  return collectCallExpressionLines(sourceFile, (node) => {
    const callee = unwrapExpression(node.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "tmpdir" &&
      ts.isIdentifier(callee.expression) &&
      osNamespaceOrDefault.has(callee.expression.text)
    ) {
      return callee;
    }
    return ts.isIdentifier(callee) && namedTmpdir.has(callee.text) ? callee : null;
  });
}

/**
 * Runs the messaging tmpdir guard.
 */
export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots: messagingTmpdirGuardSourceRoots,
    skipRelativePath: (relPath) =>
      relPath.startsWith("extensions/") && classifyBundledExtensionSourcePath(relPath).isTestLike,
    findCallLines: findMessagingTmpdirCallLines,
    header: "Found os.tmpdir()/tmpdir() usage in messaging/channel runtime sources:",
    footer:
      "Use resolvePreferredOpenClawTmpDir() or plugin-sdk temp helpers instead of host tmp defaults.",
    sortViolations: false,
  });
}

runAsScript(import.meta.url, main);
