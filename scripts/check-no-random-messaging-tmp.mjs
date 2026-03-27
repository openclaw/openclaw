#!/usr/bin/env node

import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = [
  "src/channels",
  "src/infra/outbound",
  "src/line",
  "src/media-understanding",
  "extensions",
];
const allowedRelativePaths = new Set(["extensions/feishu/src/dedup.ts"]);

function collectOsTmpdirImports(sourceFile) {
  const osModuleSpecifiers = new Set(["node:os", "os"]);
  const osNamespaceOrDefault = new Set();
  const namedTmpdir = new Set();
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

export function findMessagingTmpdirCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const { osNamespaceOrDefault, namedTmpdir } = collectOsTmpdirImports(sourceFile);
  return collectCallExpressionLines(ts, sourceFile, (node) => {
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

export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    findCallLines: findMessagingTmpdirCallLines,
    skipRelativePath: (relativePath) => allowedRelativePaths.has(relativePath),
    header: "Found os.tmpdir()/tmpdir() usage in messaging/channel runtime sources:",
    footer:
      "Use resolvePreferredOpenClawTmpDir() or plugin-sdk temp helpers instead of host tmp defaults.",
    sortViolations: false,
  });
}

runAsScript(import.meta.url, main);
