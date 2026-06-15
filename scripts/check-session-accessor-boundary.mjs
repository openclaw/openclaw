#!/usr/bin/env node

import path from "node:path";
import ts from "typescript";
import {
  collectFileViolations,
  resolveRepoRoot,
  resolveSourceRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const legacyReaderNames = new Set([
  "loadSessionStore",
  "readSessionEntries",
  "readSessionEntry",
  "readSessionStoreReadOnly",
  "resolveSessionStoreEntry",
]);
const legacyWholeStoreAccessNames = new Set([
  ...legacyReaderNames,
  "saveSessionStore",
  "updateSessionStore",
]);

export const migratedSessionAccessorFiles = new Set([
  "src/commands/export-trajectory.ts",
  "src/commands/health.ts",
  "src/commands/sandbox-explain.ts",
  "src/commands/sessions-tail.ts",
  "src/commands/sessions.ts",
  "src/commands/status.agent-local.ts",
  "src/commands/status.summary.ts",
  "src/config/sessions/combined-store-gateway.ts",
  "src/cron/isolated-agent/delivery-target.ts",
  "src/cron/service/timer.ts",
  "src/gateway/session-utils.ts",
  "src/gateway/sessions-resolve.ts",
  "src/gateway/server-methods/sessions.ts",
  "src/infra/outbound/message-action-tts.ts",
]);

export const migratedBundledPluginSessionAccessorFiles = new Set([
  "extensions/discord/src/monitor/native-command-model-picker-apply.ts",
  "extensions/discord/src/monitor/thread-session-close.ts",
  "extensions/telegram/src/bot-handlers.runtime.ts",
]);

function normalizeRelativePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function legacyNamesForFile(fileName) {
  const normalized = normalizeRelativePath(fileName);
  if (
    fileName === "source.ts" ||
    [...migratedBundledPluginSessionAccessorFiles].some((filePath) => normalized.endsWith(filePath))
  ) {
    return legacyWholeStoreAccessNames;
  }
  return legacyReaderNames;
}

function propertyAccessName(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text;
  }
  if (ts.isElementAccessExpression(unwrapped) && ts.isStringLiteral(unwrapped.argumentExpression)) {
    return unwrapped.argumentExpression.text;
  }
  return null;
}

function bindingName(node) {
  if (node.propertyName && ts.isIdentifier(node.propertyName)) {
    return node.propertyName.text;
  }
  if (ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

export function findSessionAccessorBoundaryViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const legacyNames = legacyNamesForFile(fileName);
  const violations = [];

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const specifier of namedBindings.elements) {
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          if (legacyNames.has(importedName)) {
            violations.push({
              line: toLine(sourceFile, specifier),
              reason: `imports legacy session store access "${importedName}"`,
            });
          }
        }
      }
    }

    if (ts.isBindingElement(node)) {
      const name = bindingName(node);
      if (name && legacyNames.has(name)) {
        violations.push({
          line: toLine(sourceFile, node),
          reason: `aliases legacy session store access "${name}"`,
        });
      }
    }

    if (ts.isPropertyAccessExpression(node) && legacyNames.has(node.name.text)) {
      violations.push({
        line: toLine(sourceFile, node.name),
        reason: `references legacy session store access "${node.name.text}"`,
      });
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      legacyNames.has(node.argumentExpression.text)
    ) {
      violations.push({
        line: toLine(sourceFile, node.argumentExpression),
        reason: `references legacy session store access "${node.argumentExpression.text}"`,
      });
    }

    if (ts.isCallExpression(node)) {
      const calleeName = propertyAccessName(node.expression);
      if (
        calleeName &&
        legacyNames.has(calleeName) &&
        ts.isIdentifier(unwrapExpression(node.expression))
      ) {
        violations.push({
          line: toLine(sourceFile, node.expression),
          reason: `calls legacy session store access "${calleeName}"`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const sourceRoots = resolveSourceRoots(repoRoot, [
    "extensions/discord/src/monitor",
    "extensions/telegram/src",
    "src/commands",
    "src/config/sessions",
    "src/cron",
    "src/gateway",
    "src/infra",
  ]);
  const violations = await collectFileViolations({
    repoRoot,
    sourceRoots,
    skipFile: (filePath) => {
      const relativePath = normalizeRelativePath(path.relative(repoRoot, filePath));
      return (
        !migratedSessionAccessorFiles.has(relativePath) &&
        !migratedBundledPluginSessionAccessorFiles.has(relativePath)
      );
    },
    findViolations: findSessionAccessorBoundaryViolations,
  });

  if (violations.length === 0) {
    console.log("session accessor boundary guard passed.");
    return;
  }

  console.error("Found legacy session store access usage in session-accessor migrated files:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
  }
  console.error(
    "Use src/config/sessions/session-accessor.ts helpers for migrated paths. Expand this ratchet only after a slice migrates more files.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
