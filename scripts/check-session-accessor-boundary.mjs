#!/usr/bin/env node

import fs from "node:fs/promises";
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
const sessionStoreRuntimeFileBackedCompatNames = new Set([
  "loadSessionStore",
  "readSessionEntries",
  "readSessionEntry",
  "readLatestAssistantTextFromSessionTranscript",
  "readSessionStoreReadOnly",
  "resolveAndPersistSessionFile",
  "resolveSessionFilePath",
  "resolveSessionStoreEntry",
  "saveSessionStore",
  "updateSessionStore",
]);

export const allowedSessionStoreRuntimeFileBackedCompatExports = new Set([
  "loadSessionStore",
  "readLatestAssistantTextFromSessionTranscript",
  "resolveAndPersistSessionFile",
  "resolveSessionFilePath",
  "resolveSessionStoreEntry",
  "saveSessionStore",
  "updateSessionStore",
]);

export const migratedSessionAccessorFiles = new Set([
  "packages/memory-host-sdk/src/host/session-files.ts",
  "src/acp/runtime/session-meta.ts",
  "src/agents/acp-spawn.ts",
  "src/agents/auth-profiles/session-override.ts",
  "src/agents/embedded-agent-runner/compaction-successor-transcript.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/agents/embedded-agent-runner/tool-result-truncation.ts",
  "src/agents/embedded-agent-runner/transcript-rewrite.ts",
  "src/agents/embedded-agent-runner/transcript-runtime-state.ts",
  "src/auto-reply/reply/abort.ts",
  "src/agents/subagent-control.ts",
  "src/agents/subagent-registry-helpers.ts",
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
  "src/commands/tasks.ts",
  "src/config/sessions/combined-store-gateway.ts",
  "src/cron/isolated-agent/delivery-target.ts",
  "src/cron/service/timer.ts",
  "src/gateway/session-compaction-checkpoints.ts",
  "src/gateway/session-history-state.ts",
  "src/gateway/sessions-history-http.ts",
  "src/gateway/session-utils.ts",
  "src/gateway/managed-image-attachments.ts",
  "src/gateway/server-methods/artifacts.ts",
  "src/gateway/server-methods/chat.ts",
  "src/gateway/sessions-resolve.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/gateway/server-methods/sessions.ts",
  "src/gateway/server-session-events.ts",
  "src/gateway/session-reset-service.ts",
  "src/infra/outbound/message-action-tts.ts",
  "src/agents/tools/embedded-gateway-stub.ts",
  "src/agents/tools/sessions-list-tool.ts",
  "src/plugins/host-hook-state.ts",
  "src/status/status-message.ts",
  "src/tui/embedded-backend.ts",
]);

export const migratedBundledPluginSessionAccessorFiles = new Set([
  "extensions/discord/src/monitor/native-command-model-picker-apply.ts",
  "extensions/discord/src/monitor/thread-session-close.ts",
  "extensions/memory-core/src/dreaming-narrative.ts",
  "extensions/telegram/src/bot-handlers.runtime.ts",
]);

export const migratedSessionAccessorWriteFiles = new Set([
  "src/acp/runtime/session-meta.ts",
  "src/agents/auth-profiles/session-override.ts",
  "src/agents/command/attempt-execution.shared.ts",
  "src/agents/command/session-store.ts",
  "src/agents/embedded-agent-runner/run.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/agents/live-model-switch.ts",
  "src/agents/main-session-restart-recovery.ts",
  "src/auto-reply/reply/abort.ts",
  "src/agents/subagent-control.ts",
  "src/agents/subagent-registry-helpers.ts",
  "src/auto-reply/reply/abort-cutoff.runtime.ts",
  "src/auto-reply/reply/agent-runner-cli-dispatch.ts",
  "src/auto-reply/reply/agent-runner-execution.ts",
  "src/auto-reply/reply/agent-runner-memory.ts",
  "src/auto-reply/reply/agent-runner-session-reset.ts",
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
  "src/auto-reply/reply/session.ts",
  "src/auto-reply/reply/session-reset-model.ts",
  "src/auto-reply/reply/session-updates.ts",
  "src/auto-reply/reply/session-usage.ts",
  "src/commands/tasks.ts",
  "src/config/sessions/cleanup-service.ts",
  "src/plugins/host-hook-cleanup.ts",
  "src/plugins/host-hook-state.ts",
  "src/tui/embedded-backend.ts",
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

export const migratedMemoryHostSessionCorpusFiles = new Set([
  "packages/memory-host-sdk/src/host/session-files.ts",
  "packages/memory-host-sdk/src/host/session-transcript-corpus.ts",
]);

const memoryHostSessionCorpusFunctionNames = new Set([
  "listSessionTranscriptCorpusEntriesForAgentSync",
  "listSessionTranscriptCorpusEntriesForAgent",
  "loadDreamingNarrativeTranscriptPathSetForAgent",
  "loadSessionTranscriptClassificationForAgent",
  "listSessionFilesForAgent",
]);

const legacyMemoryHostSessionCorpusNames = new Set([
  "loadSessionTranscriptClassificationForSessionsDir",
  "readSessionTranscriptClassificationStore",
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

export function collectSessionStoreRuntimeFileBackedCompatExports(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const exports = new Map();

  const rememberExport = (node, exportedName, sourceName = exportedName) => {
    if (!sessionStoreRuntimeFileBackedCompatNames.has(sourceName)) {
      return;
    }
    exports.set(exportedName, {
      line: toLine(sourceFile, node),
      sourceName,
    });
  };

  for (const statement of sourceFile.statements) {
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (isExported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          rememberExport(declaration.name, declaration.name.text);
        }
      }
      continue;
    }
    if (isExported && ts.isFunctionDeclaration(statement) && statement.name) {
      rememberExport(statement.name, statement.name.text);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const specifier of statement.exportClause.elements) {
        rememberExport(
          specifier,
          specifier.name.text,
          specifier.propertyName?.text ?? specifier.name.text,
        );
      }
    }
  }

  return exports;
}

export function findSessionStoreRuntimeFileBackedCompatExportViolations(
  content,
  fileName = "source.ts",
) {
  const exports = collectSessionStoreRuntimeFileBackedCompatExports(content, fileName);
  const violations = [];
  for (const [exportedName, exported] of exports) {
    if (
      exportedName !== exported.sourceName ||
      !allowedSessionStoreRuntimeFileBackedCompatExports.has(exportedName)
    ) {
      violations.push({
        line: exported.line,
        reason: `exports unratcheted file-backed SDK session helper "${exported.sourceName}"`,
      });
    }
  }
  return violations;
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

function declarationName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (!ts.isVariableStatement(node)) {
    return null;
  }
  const declaration = node.declarationList.declarations[0];
  return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
}

function functionBodyForDeclaration(node) {
  if (ts.isFunctionDeclaration(node)) {
    return node.body ?? null;
  }
  if (!ts.isVariableStatement(node)) {
    return null;
  }
  const declaration = node.declarationList.declarations[0];
  const initializer = declaration?.initializer;
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return initializer.body;
  }
  return null;
}

function collectTopLevelFunctionBodies(sourceFile) {
  const bodies = new Map();
  for (const statement of sourceFile.statements) {
    const name = declarationName(statement);
    const body = functionBodyForDeclaration(statement);
    if (name && body) {
      bodies.set(name, body);
    }
  }
  return bodies;
}

export function findMemoryHostSessionCorpusBoundaryViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const functionBodies = collectTopLevelFunctionBodies(sourceFile);
  const visitedFunctions = new Set();
  const violationKeys = new Set();
  const violations = [];

  const visitCorpusBody = (node) => {
    if (ts.isCallExpression(node)) {
      const calleeName = propertyAccessName(node.expression);
      if (calleeName && legacyMemoryHostSessionCorpusNames.has(calleeName)) {
        const line = toLine(sourceFile, node.expression);
        const reason = `calls legacy memory-host session corpus helper "${calleeName}"`;
        const key = `${line}:${reason}`;
        if (!violationKeys.has(key)) {
          violationKeys.add(key);
          violations.push({ line, reason });
        }
      }
      if (calleeName && ts.isIdentifier(unwrapExpression(node.expression))) {
        const localBody = functionBodies.get(calleeName);
        if (localBody && !visitedFunctions.has(calleeName)) {
          visitedFunctions.add(calleeName);
          visitCorpusBody(localBody);
        }
      }
    }
    ts.forEachChild(node, visitCorpusBody);
  };

  for (const name of memoryHostSessionCorpusFunctionNames) {
    const body = functionBodies.get(name);
    if (!body || visitedFunctions.has(name)) {
      continue;
    }
    visitedFunctions.add(name);
    visitCorpusBody(body);
  }

  return violations;
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const readSourceRoots = resolveSourceRoots(repoRoot, [
    "packages/memory-host-sdk/src/host",
    "extensions/discord/src/monitor",
    "extensions/memory-core/src",
    "extensions/telegram/src",
    "src/acp",
    "src/agents",
    "src/auto-reply",
    "src/commands",
    "src/config/sessions",
    "src/cron",
    "src/gateway",
    "src/infra",
    "src/plugins",
    "src/tui",
  ]);
  const writeSourceRoots = resolveSourceRoots(repoRoot, [
    "src/acp",
    "src/agents",
    "src/auto-reply",
    "src/commands",
    "src/config/sessions",
    "src/plugins",
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
  const memoryHostSessionCorpusViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["packages/memory-host-sdk/src/host"]),
    skipFile: (filePath) =>
      !migratedMemoryHostSessionCorpusFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findMemoryHostSessionCorpusBoundaryViolations,
  });
  const sessionStoreRuntimePath = path.join(repoRoot, "src/plugin-sdk/session-store-runtime.ts");
  const sessionStoreRuntimeCompatViolations =
    findSessionStoreRuntimeFileBackedCompatExportViolations(
      await fs.readFile(sessionStoreRuntimePath, "utf8"),
      sessionStoreRuntimePath,
    ).map((violation) =>
      Object.assign({ path: "src/plugin-sdk/session-store-runtime.ts" }, violation),
    );
  const violations = [
    ...readViolations,
    ...writeViolations,
    ...transcriptWriterViolations,
    ...sessionCreateLifecycleViolations,
    ...manualCompactTrimViolations,
    ...lifecycleCleanupViolations,
    ...memoryHostSessionCorpusViolations,
    ...sessionStoreRuntimeCompatViolations,
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
    "Use src/config/sessions/session-accessor.ts helpers for migrated read/write and transcript-writer paths. Expand file-backed SDK compatibility only as an explicit pre-SQLite migration decision.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
