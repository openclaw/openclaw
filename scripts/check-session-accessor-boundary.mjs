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
const legacyWriterNames = new Set([
  "applySessionStoreEntryPatch",
  "updateSessionStore",
  "updateSessionStoreEntry",
]);

export const migratedSessionAccessorFiles = new Set([
  "src/agents/embedded-agent-runner/run/attempt.ts",
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

export const migratedSessionAccessorWriteFiles = new Set([
  "src/agents/command/attempt-execution.shared.ts",
  "src/agents/embedded-agent-runner/run.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/auto-reply/reply/abort-cutoff.runtime.ts",
  "src/auto-reply/reply/agent-runner-cli-dispatch.ts",
  "src/auto-reply/reply/agent-runner-execution.ts",
  "src/auto-reply/reply/agent-runner-memory.ts",
  "src/auto-reply/reply/agent-runner.ts",
  "src/auto-reply/reply/body.ts",
  "src/auto-reply/reply/commands-acp/lifecycle.ts",
  "src/auto-reply/reply/commands-reset.ts",
  "src/auto-reply/reply/directive-handling.impl.ts",
  "src/auto-reply/reply/directive-handling.persist.ts",
  "src/auto-reply/reply/dispatch-from-config.runtime.ts",
  "src/auto-reply/reply/followup-runner.ts",
  "src/auto-reply/reply/get-reply.ts",
  "src/auto-reply/reply/model-selection.ts",
  "src/auto-reply/reply/session-reset-model.ts",
  "src/auto-reply/reply/session-updates.ts",
  "src/auto-reply/reply/session-usage.ts",
]);

function normalizeRelativePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
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

function findNamedSessionStoreViolations(content, fileName, legacyNames, legacyKind) {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
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
              reason: `imports legacy session store ${legacyKind} "${importedName}"`,
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
          reason: `aliases legacy session store ${legacyKind} "${name}"`,
        });
      }
    }

    if (ts.isPropertyAccessExpression(node) && legacyNames.has(node.name.text)) {
      violations.push({
        line: toLine(sourceFile, node.name),
        reason: `references legacy session store ${legacyKind} "${node.name.text}"`,
      });
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      legacyNames.has(node.argumentExpression.text)
    ) {
      violations.push({
        line: toLine(sourceFile, node.argumentExpression),
        reason: `references legacy session store ${legacyKind} "${node.argumentExpression.text}"`,
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
          reason: `calls legacy session store ${legacyKind} "${calleeName}"`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function findSessionAccessorBoundaryViolations(content, fileName = "source.ts") {
  return findNamedSessionStoreViolations(content, fileName, legacyReaderNames, "reader");
}

export function findSessionAccessorWriteBoundaryViolations(content, fileName = "source.ts") {
  return findNamedSessionStoreViolations(content, fileName, legacyWriterNames, "writer");
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const readSourceRoots = resolveSourceRoots(repoRoot, [
    "src/agents",
    "src/commands",
    "src/config/sessions",
    "src/cron",
    "src/gateway",
    "src/infra",
  ]);
  const writeSourceRoots = resolveSourceRoots(repoRoot, ["src/agents", "src/auto-reply"]);
  const readViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: readSourceRoots,
    skipFile: (filePath) =>
      !migratedSessionAccessorFiles.has(normalizeRelativePath(path.relative(repoRoot, filePath))),
    findViolations: findSessionAccessorBoundaryViolations,
  });
  const writeViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: writeSourceRoots,
    skipFile: (filePath) =>
      !migratedSessionAccessorWriteFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findSessionAccessorWriteBoundaryViolations,
  });
  const violations = [...readViolations, ...writeViolations];

  if (violations.length === 0) {
    console.log("session accessor boundary guard passed.");
    return;
  }

  console.error("Found legacy session store usage in session-accessor migrated files:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
  }
  console.error(
    "Use src/config/sessions/session-accessor.ts helpers for migrated read/write paths. Expand this ratchet only after a slice migrates more files.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
