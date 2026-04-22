#!/usr/bin/env node

import ts from "typescript";
import { bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

export const messagingTmpdirGuardSourceRoots = [
  "src/channels",
  "src/infra/outbound",
  "src/line",
  "src/media",
  "src/media-understanding",
  "extensions",
];
const allowedRelativePaths = new Set([
  bundledPluginFile("feishu", "src/dedup.ts"),
  "src/infra/outbound/delivery-queue.test-helpers.ts",
  "extensions/active-memory/index.ts",
  "extensions/browser/src/browser/chrome-mcp.ts",
  "extensions/diffs/src/test-helpers.ts",
  "extensions/google/video-generation-provider.ts",
  "extensions/memory-core/src/cli.runtime.ts",
  "extensions/memory-core/src/test-helpers.ts",
  "extensions/memory-wiki/src/test-helpers.ts",
  "extensions/openshell/src/backend.ts",
  "extensions/qa-lab/src/gateway-child.ts",
  "extensions/qa-lab/src/model-catalog.runtime.ts",
  "extensions/qqbot/src/utils/platform.ts",
  "extensions/signal/src/install-signal-cli.ts",
]);

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
    sourceRoots: messagingTmpdirGuardSourceRoots,
    findCallLines: findMessagingTmpdirCallLines,
    skipRelativePath: (relativePath) => allowedRelativePaths.has(relativePath),
    header: "Found os.tmpdir()/tmpdir() usage in messaging/channel runtime sources:",
    footer:
      "Use resolvePreferredOpenClawTmpDir() or plugin-sdk temp helpers instead of host tmp defaults.",
    sortViolations: false,
  });
}

runAsScript(import.meta.url, main);
