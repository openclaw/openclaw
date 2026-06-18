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
const legacyWriterNames = new Set([
  "applySessionStoreEntryPatch",
  "saveSessionStore",
  "updateSessionStore",
  "updateSessionStoreEntry",
]);
const legacyTranscriptWriterNames = new Set([
  "appendSessionTranscriptMessage",
  "emitSessionTranscriptUpdate",
  "rewriteTranscriptEntriesInSessionFile",
]);
const sessionCreateLifecycleWriterNames = new Set([
  "applySessionStoreEntryPatch",
  "saveSessionStore",
  "updateSessionStore",
  "updateSessionStoreEntry",
  "ensureSessionTranscriptFile",
]);
const legacyManualCompactTrimNames = new Set([
  "archiveFileOnDisk",
  "readRecentSessionTranscriptLines",
]);
const legacyLifecycleCleanupNames = new Set([
  "archiveRemovedSessionTranscripts",
  "cleanupArchivedSessionTranscripts",
]);

export const migratedSessionAccessorFiles = new Set([
  "src/agents/embedded-agent-runner/compaction-successor-transcript.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/agents/embedded-agent-runner/tool-result-truncation.ts",
  "src/agents/embedded-agent-runner/transcript-rewrite.ts",
  "src/agents/embedded-agent-runner/transcript-runtime-state.ts",
  "src/auto-reply/reply/agent-runner-helpers.ts",
  "src/auto-reply/reply/agent-runner.ts",
  "src/auto-reply/reply/commands-subagents/action-info.ts",
  "src/auto-reply/reply/followup-runner.ts",
  "src/auto-reply/reply/queue/drain.ts",
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
  "src/gateway/session-compaction-checkpoints.ts",
  "src/gateway/session-utils.ts",
  "src/gateway/sessions-resolve.ts",
  "src/gateway/server-methods/sessions.ts",
  "src/infra/outbound/message-action-tts.ts",
  "src/tui/embedded-backend.ts",
]);

export const migratedBundledPluginSessionAccessorFiles = new Set([
  "extensions/discord/src/monitor/native-command-model-picker-apply.ts",
  "extensions/discord/src/monitor/thread-session-close.ts",
  "extensions/telegram/src/bot-handlers.runtime.ts",
]);

export const migratedSessionAccessorWriteFiles = new Set([
  "src/agents/command/attempt-execution.shared.ts",
  "src/agents/command/session-store.ts",
  "src/agents/embedded-agent-runner/run.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/agents/main-session-restart-recovery.ts",
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
  "src/tui/embedded-backend.ts",
  "src/config/sessions/cleanup-service.ts",
]);

export const migratedTranscriptWriterFiles = new Set([
  "src/agents/command/attempt-execution.ts",
  "src/agents/embedded-agent-runner/context-engine-maintenance.ts",
  "src/config/sessions/transcript.ts",
  "src/gateway/server-methods/chat.ts",
  "src/gateway/server-methods/chat-transcript-inject.ts",
  "src/sessions/user-turn-transcript.ts",
]);

export const migratedSessionCompactManualTrimFiles = new Set([
  "src/gateway/server-methods/sessions.ts",
]);

export const migratedSessionLifecycleCleanupFiles = new Set([
  "src/config/sessions/cleanup-service.ts",
  "src/cron/session-reaper.ts",
  "src/infra/heartbeat-runner.ts",
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

function findNamedBoundaryViolations(content, fileName, legacyNames, subject) {
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
              reason: `imports ${subject} "${importedName}"`,
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
          reason: `aliases ${subject} "${name}"`,
        });
      }
    }

    if (ts.isPropertyAccessExpression(node) && legacyNames.has(node.name.text)) {
      violations.push({
        line: toLine(sourceFile, node.name),
        reason: `references ${subject} "${node.name.text}"`,
      });
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      legacyNames.has(node.argumentExpression.text)
    ) {
      violations.push({
        line: toLine(sourceFile, node.argumentExpression),
        reason: `references ${subject} "${node.argumentExpression.text}"`,
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
          reason: `calls ${subject} "${calleeName}"`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function findNamedSessionStoreViolations(content, fileName, legacyNames, legacyKind) {
  return findNamedBoundaryViolations(
    content,
    fileName,
    legacyNames,
    `legacy session store ${legacyKind}`,
  );
}

export function findSessionAccessorBoundaryViolations(content, fileName = "source.ts") {
  const legacyNames = legacyNamesForFile(fileName);
  const legacyKind = legacyNames === legacyWholeStoreAccessNames ? "access" : "reader";
  return findNamedSessionStoreViolations(content, fileName, legacyNames, legacyKind);
}

export function findSessionAccessorWriteBoundaryViolations(content, fileName = "source.ts") {
  return findNamedSessionStoreViolations(content, fileName, legacyWriterNames, "writer");
}

export function findTranscriptWriterBoundaryViolations(content, fileName = "source.ts") {
  return findNamedBoundaryViolations(
    content,
    fileName,
    legacyTranscriptWriterNames,
    "legacy transcript writer",
  );
}

export function findGatewaySessionCreateLifecycleViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visitCreateHandler = (node) => {
    if (ts.isCallExpression(node)) {
      const calleeName = propertyAccessName(node.expression);
      if (calleeName && sessionCreateLifecycleWriterNames.has(calleeName)) {
        violations.push({
          line: toLine(sourceFile, node.expression),
          reason: `calls legacy sessions.create lifecycle writer "${calleeName}"`,
        });
      }
    }
    ts.forEachChild(node, visitCreateHandler);
  };

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteralLike(node.name) &&
      node.name.text === "sessions.create"
    ) {
      visitCreateHandler(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function findSessionCompactManualTrimBoundaryViolations(content, fileName = "source.ts") {
  return findNamedSessionStoreViolations(
    content,
    fileName,
    legacyManualCompactTrimNames,
    "manual compact trim",
  );
}

export function findSessionLifecycleCleanupBoundaryViolations(content, fileName = "source.ts") {
  return findNamedSessionStoreViolations(
    content,
    fileName,
    legacyLifecycleCleanupNames,
    "lifecycle cleanup",
  );
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const readSourceRoots = resolveSourceRoots(repoRoot, [
    "extensions/discord/src/monitor",
    "extensions/telegram/src",
    "src/agents",
    "src/auto-reply",
    "src/commands",
    "src/config/sessions",
    "src/cron",
    "src/gateway",
    "src/infra",
    "src/tui",
  ]);
  const writeSourceRoots = resolveSourceRoots(repoRoot, [
    "src/agents",
    "src/auto-reply",
    "src/config/sessions",
    "src/tui",
  ]);
  const transcriptWriterSourceRoots = resolveSourceRoots(repoRoot, [
    "src/agents/command",
    "src/agents/embedded-agent-runner",
    "src/config/sessions",
    "src/gateway/server-methods",
    "src/sessions",
  ]);
  const readViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: readSourceRoots,
    skipFile: (filePath) => {
      const relativePath = normalizeRelativePath(path.relative(repoRoot, filePath));
      return (
        !migratedSessionAccessorFiles.has(relativePath) &&
        !migratedBundledPluginSessionAccessorFiles.has(relativePath)
      );
    },
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
  const transcriptWriterViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: transcriptWriterSourceRoots,
    skipFile: (filePath) =>
      !migratedTranscriptWriterFiles.has(normalizeRelativePath(path.relative(repoRoot, filePath))),
    findViolations: findTranscriptWriterBoundaryViolations,
  });
  const sessionCreateLifecycleViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["src/gateway/server-methods"]),
    skipFile: (filePath) =>
      normalizeRelativePath(path.relative(repoRoot, filePath)) !==
      "src/gateway/server-methods/sessions.ts",
    findViolations: findGatewaySessionCreateLifecycleViolations,
  });
  const manualCompactTrimViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["src/gateway/server-methods"]),
    skipFile: (filePath) =>
      !migratedSessionCompactManualTrimFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findSessionCompactManualTrimBoundaryViolations,
  });
  const lifecycleCleanupViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: readSourceRoots,
    skipFile: (filePath) =>
      !migratedSessionLifecycleCleanupFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findSessionLifecycleCleanupBoundaryViolations,
  });
  const violations = [
    ...readViolations,
    ...writeViolations,
    ...transcriptWriterViolations,
    ...sessionCreateLifecycleViolations,
    ...manualCompactTrimViolations,
    ...lifecycleCleanupViolations,
  ];

  if (violations.length === 0) {
    console.log("session accessor boundary guard passed.");
    return;
  }

  console.error("Found legacy session store usage in session-accessor migrated files:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
  }
  console.error(
    "Use src/config/sessions/session-accessor.ts helpers for migrated read/write and transcript-writer paths. Expand this ratchet only after a slice migrates more files.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
