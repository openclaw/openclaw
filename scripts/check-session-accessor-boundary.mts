#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript/ast";
import { z } from "zod";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  collectFileViolations,
  getPropertyNameText,
  resolveSourceRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mts";

const legacyReaderNames = new Set(["resolveSessionStoreEntryCore"]);
const legacyWriterNames = new Set([
  "recordSessionMetaFromInbound",
  "updateLastRoute",
  "updateSessionStoreEntry",
]);
const legacyTranscriptWriterNames = new Set([
  "appendSessionTranscriptMessage",
  "emitSessionTranscriptUpdate",
]);
const legacyLifecycleCleanupNames = new Set([
  "archiveRemovedSessionTranscripts",
  "cleanupArchivedSessionTranscripts",
]);
const sessionStoreRuntimeFileBackedCompatNames = new Set([
  "readLatestAssistantTextFromSessionTranscript",
  "resolveAndPersistSessionFile",
  "resolveSessionFilePath",
]);
const embeddedAgentSessionFileRuntimeNames = new Set(["resolveSessionFilePath"]);
const materializingSessionEntryAccessorNames = new Set([
  "listSessionEntriesCore",
  "loadSessionEntry",
]);

const gatewaySessionServerMethodFiles = [
  "src/gateway/server-methods/sessions-abort.ts",
  "src/gateway/server-methods/sessions-compact.ts",
  "src/gateway/server-methods/sessions-compaction-runner.ts",
  "src/gateway/server-methods/sessions-create.ts",
  "src/gateway/server-methods/sessions-delete.ts",
  "src/gateway/server-methods/sessions-dispatch.ts",
  "src/gateway/server-methods/sessions-groups.ts",
  "src/gateway/server-methods/sessions-messaging.ts",
  "src/gateway/server-methods/sessions-mutations.ts",
  "src/gateway/server-methods/sessions-read.ts",
  "src/gateway/server-methods/sessions-shared.ts",
  "src/gateway/server-methods/sessions-subscriptions.ts",
];

const migratedSessionAccessorFiles = new Set([
  "packages/memory-host-sdk/src/host/session-files.ts",
  "src/acp/control-plane/manager.core.ts",
  "src/acp/runtime/session-meta.ts",
  "src/agents/subagents/spawn/acp-spawn.ts",
  "src/agents/auth-profiles/session-override.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/agents/embedded-agent-runner/tool-result-truncation.ts",
  "src/agents/embedded-agent-runner/transcript-rewrite.ts",
  "src/agents/live-model-switch.ts",
  "src/agents/subagents/registry/subagent-control.ts",
  "src/agents/subagents/registry/subagent-registry-helpers.ts",
  "src/auto-reply/reply/abort.ts",
  "src/auto-reply/reply/agent-runner-helpers.ts",
  "src/auto-reply/reply/commands-subagents/action-info.ts",
  "src/auto-reply/reply/followup-runner.ts",
  "src/auto-reply/reply/queue/drain.ts",
  "src/commands/export-trajectory.ts",
  "src/commands/health.ts",
  "src/commands/sandbox-explain.ts",
  "src/commands/sessions-tail.ts",
  "src/commands/sessions.ts",
  "src/commands/status.agent-local.ts",
  "src/status/summary.ts",
  "src/config/sessions/combined-store-gateway.ts",
  "src/config/sessions/delivery-info.ts",
  "src/config/sessions/goals.ts",
  "src/cron/isolated-agent/delivery-target.ts",
  "src/gateway/session-history-state.ts",
  "src/gateway/sessions-history-http.ts",
  "src/gateway/session-utils.ts",
  "src/gateway/managed-image-attachments.ts",
  "src/gateway/boot.ts",
  "src/gateway/server-methods/artifacts.ts",
  "src/gateway/server-methods/chat.ts",
  "src/gateway/sessions-resolve.ts",
  "src/gateway/server-methods/sessions-files.ts",
  ...gatewaySessionServerMethodFiles,
  "src/gateway/server-session-events.ts",
  "src/gateway/session-reset-service.ts",
  "src/infra/outbound/message-action-send.ts",
  "src/agents/tools/embedded-gateway-stub.ts",
  "src/agents/tools/session-status-tool.ts",
  "src/agents/tools/sessions-list-tool.ts",
  "src/plugins/host-hook-state.ts",
  "src/status/status-message.ts",
  "src/tui/embedded-backend.ts",
]);

const migratedBundledPluginSessionAccessorFiles = new Set([
  "extensions/codex/src/conversation-binding.ts",
  "extensions/discord/src/monitor/native-command-model-picker-ui.ts",
  "extensions/discord/src/monitor/native-command-model-picker-apply.ts",
  "extensions/discord/src/monitor/thread-session-close.ts",
  "extensions/feishu/src/reasoning-preview.ts",
  "extensions/memory-core/src/dreaming-phases.ts",
  "extensions/memory-core/src/dreaming-narrative.ts",
  "extensions/mattermost/src/mattermost/model-picker.ts",
  "extensions/matrix/src/matrix/monitor/handler.ts",
  "extensions/matrix/src/session-route.ts",
  "extensions/slack/src/monitor/slash.ts",
  "extensions/telegram/src/bot-core.ts",
  "extensions/telegram/src/bot-handlers.runtime.ts",
  "extensions/telegram/src/bot.ts",
  "extensions/telegram/src/bot-message-dispatch.ts",
  "extensions/telegram/src/bot-native-commands.ts",
  "extensions/voice-call/src/response-generator.ts",
  "extensions/whatsapp/src/auto-reply/monitor/group-activation.ts",
]);

const migratedEmbeddedAgentSessionTargetFiles = new Set([
  "extensions/voice-call/src/response-generator.ts",
]);

const migratedSessionAccessorWriteFiles = new Set([
  "src/acp/runtime/session-meta.ts",
  "src/agents/auth-profiles/session-override.ts",
  "src/agents/command/attempt-execution.shared.ts",
  "src/agents/command/session-store.ts",
  "src/agents/embedded-agent-runner/run.ts",
  "src/agents/embedded-agent-subscribe.handlers.compaction.runtime.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/agents/live-model-switch.ts",
  "src/agents/main-session-recovery/main-session-restart-recovery-checkpoint.ts",
  "src/agents/main-session-recovery/main-session-restart-recovery-marking.ts",
  "src/agents/main-session-recovery/main-session-restart-recovery-store.ts",
  "src/agents/session-suspension.ts",
  "src/auto-reply/reply/abort.ts",
  "src/agents/subagents/registry/subagent-control.ts",
  "src/agents/subagents/registry/subagent-registry-helpers.ts",
  "src/agents/tools/session-status-tool.ts",
  "src/auto-reply/reply/abort-cutoff.runtime.ts",
  "src/auto-reply/reply/agent-runner-cli-dispatch.ts",
  "src/auto-reply/reply/agent-runner-execution.ts",
  "src/auto-reply/reply/agent-runner-memory.ts",
  "src/auto-reply/reply/body.ts",
  "src/auto-reply/reply/commands-acp/lifecycle.ts",
  "src/auto-reply/reply/commands-reset.ts",
  "src/auto-reply/reply/commands-session-store.ts",
  "src/auto-reply/reply/directive-handling.impl.ts",
  "src/auto-reply/reply/followup-runner.ts",
  "src/auto-reply/reply/get-reply.ts",
  "src/auto-reply/reply/model-selection.ts",
  "src/auto-reply/reply/session.ts",
  "src/auto-reply/reply/session-reset-model.ts",
  "src/auto-reply/reply/session-updates.ts",
  "src/auto-reply/reply/session-usage.ts",
  "src/config/sessions/cleanup-service.ts",
  "src/config/sessions/goals.ts",
  "src/gateway/boot.ts",
  "src/gateway/server-methods/chat.ts",
  ...gatewaySessionServerMethodFiles,
  "src/gateway/server-node-events.ts",
  "src/infra/outbound/outbound-session.ts",
  "src/plugins/host-hook-cleanup.ts",
  "src/plugins/host-hook-state.ts",
  "src/plugins/runtime/runtime-channel.ts",
  "src/tui/embedded-backend.ts",
]);

const migratedTranscriptWriterFiles = new Set([
  "src/agents/command/attempt-execution.ts",
  "src/agents/embedded-agent-runner/context-engine-maintenance.ts",
  "src/config/sessions/transcript.ts",
  "src/gateway/server-methods/chat.ts",
  "src/gateway/server-methods/chat-transcript-inject.ts",
  "src/sessions/user-turn-transcript.ts",
]);

const migratedSessionLifecycleCleanupFiles = new Set([
  "src/config/sessions/cleanup-service.ts",
  "src/cron/session-reaper.ts",
  "src/infra/heartbeat-runner.ts",
]);

export const readOnlyGatewaySessionAccessorFiles = new Set([
  "src/gateway/approval-session-audience.ts",
  "src/gateway/control-ui-session-prs.ts",
  "src/gateway/managed-image-attachments.ts",
  "src/gateway/mcp-app-reconstruction.ts",
  "src/gateway/server-chat.ts",
  "src/gateway/server-methods/artifacts.ts",
  "src/gateway/server-methods/chat-history-handler.ts",
  "src/gateway/server-methods/chat-message-get-handler.ts",
  "src/gateway/server-methods/sessions-diff.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/gateway/server-methods/sessions-read.ts",
  "src/gateway/server-methods/sessions-subscriptions.ts",
  "src/gateway/server-methods/task-suggestions.ts",
  "src/gateway/server-methods/tools-effective.ts",
  "src/gateway/server-methods/usage-session-selection.ts",
  "src/gateway/server-session-events.ts",
]);

const migratedMemoryHostSessionCorpusFiles = new Set([
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

type BoundaryViolation = { line: number; reason: string };
const sessionAccessorDebtCountsSchema = z.record(z.string(), z.record(z.string(), z.number()));
type SessionAccessorDebtCounts = z.infer<typeof sessionAccessorDebtCountsSchema>;

function normalizeRelativePath(filePath: string) {
  return filePath.replaceAll(path.sep, "/");
}

function propertyAccessName(expression: ts.Expression) {
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

function bindingName(node: ts.BindingElement) {
  const name =
    node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName : node.name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

type NamedReference = {
  node: ts.Node;
  action: string;
  name: string;
  declaration?: ts.ImportDeclaration;
  specifier?: ts.ImportSpecifier;
  property?: ts.PropertyAccessExpression;
};
type CallFact = { node: ts.CallExpression; name: string | null; direct: boolean };
type SessionAccessorSyntaxFacts = {
  sourceFile: ts.SourceFile;
  references: NamedReference[];
  calls: CallFact[];
  embeddedAgentCalls: ts.CallExpression[];
  createHandlerCalls: CallFact[];
};

export function collectSessionAccessorSyntaxFacts(
  sourceFile: ts.SourceFile,
): SessionAccessorSyntaxFacts {
  const references: NamedReference[] = [];
  const calls: CallFact[] = [];
  const embeddedAgentCalls: ts.CallExpression[] = [];
  const createHandlerCalls: CallFact[] = [];
  const visit = (node: ts.Node, insideEmbeddedAgentCall = false, insideCreateHandler = false) => {
    const inCreateHandler =
      insideCreateHandler ||
      (ts.isPropertyAssignment(node) &&
        ts.isStringLiteralLikeNode(node.name) &&
        node.name.text === "sessions.create");
    let inEmbeddedAgentCall = insideEmbeddedAgentCall;
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          references.push({
            node: specifier,
            action: "imports",
            name: specifier.propertyName?.text ?? specifier.name.text,
            declaration: node,
            specifier,
          });
        }
      }
    }
    if (ts.isBindingElement(node)) {
      const name = bindingName(node);
      if (name) {
        references.push({ node, action: "aliases", name });
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      references.push({
        node: node.name,
        action: "references",
        name: node.name.text,
        property: node,
      });
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      references.push({
        node: node.argumentExpression,
        action: "references",
        name: node.argumentExpression.text,
      });
    }
    if (ts.isCallExpression(node)) {
      const name = propertyAccessName(node.expression);
      const direct = ts.isIdentifier(unwrapExpression(node.expression));
      const call = { node, name, direct };
      calls.push(call);
      if (inCreateHandler) {
        createHandlerCalls.push(call);
      }
      if (name && direct) {
        references.push({ node: node.expression, action: "calls", name });
      }
      if (name === "runEmbeddedAgent") {
        if (!insideEmbeddedAgentCall) {
          embeddedAgentCalls.push(node);
        }
        inEmbeddedAgentCall = true;
      }
    }
    node.forEachChild((child) => visit(child, inEmbeddedAgentCall, inCreateHandler));
  };
  visit(sourceFile);
  return { sourceFile, references, calls, embeddedAgentCalls, createHandlerCalls };
}

function findNamedBoundaryViolations(
  facts: SessionAccessorSyntaxFacts,
  legacyNames: ReadonlySet<string>,
  subject: string,
  allowed?: {
    import?: (declaration: ts.ImportDeclaration, specifier: ts.ImportSpecifier) => boolean;
    reference?: (node: ts.PropertyAccessExpression) => boolean;
  },
) {
  return facts.references
    .filter(
      (reference) =>
        legacyNames.has(reference.name) &&
        !(
          reference.declaration &&
          reference.specifier &&
          allowed?.import?.(reference.declaration, reference.specifier)
        ) &&
        !(reference.property && allowed?.reference?.(reference.property)),
    )
    .map(({ node, action, name }) => ({
      line: toLine(facts.sourceFile, node),
      reason: `${action} ${subject} "${name}"`,
    }));
}

function namedBoundaryRule(legacyNames: ReadonlySet<string>, subject: string) {
  return (_content: string, _fileName: string, facts: SessionAccessorSyntaxFacts) =>
    findNamedBoundaryViolations(facts, legacyNames, subject);
}

export function collectSessionStoreRuntimeFileBackedCompatExports(
  _content: string,
  _fileName: string,
  facts: SessionAccessorSyntaxFacts,
) {
  const exports = new Map<string, { line: number; sourceName: string }>();

  const rememberExport = (node: ts.Node, exportedName: string, sourceName = exportedName) => {
    if (!sessionStoreRuntimeFileBackedCompatNames.has(sourceName)) {
      return;
    }
    exports.set(exportedName, {
      line: toLine(facts.sourceFile, node),
      sourceName,
    });
  };

  for (const statement of facts.sourceFile.statements) {
    const isExported =
      (ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement)) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
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
  content: string,
  fileName: string,
  facts: SessionAccessorSyntaxFacts,
) {
  const exports = collectSessionStoreRuntimeFileBackedCompatExports(content, fileName, facts);
  return Array.from(exports.values(), (exported) => ({
    line: exported.line,
    reason: `exports retired file-backed SDK session helper "${exported.sourceName}"`,
  }));
}

export function findSessionAccessorBoundaryViolations(
  _content: string,
  fileName: string,
  facts: SessionAccessorSyntaxFacts,
) {
  const legacyKind =
    fileName === "source.ts" ||
    [...migratedBundledPluginSessionAccessorFiles].some((filePath) =>
      normalizeRelativePath(fileName).endsWith(filePath),
    )
      ? "access"
      : "reader";
  return findNamedBoundaryViolations(
    facts,
    legacyReaderNames,
    `legacy session store ${legacyKind}`,
  );
}

export const findReadOnlySessionAccessorViolations = namedBoundaryRule(
  materializingSessionEntryAccessorNames,
  "materializing session entry accessor",
);

export function findEmbeddedAgentSessionTargetViolations(
  _content: string,
  _fileName: string,
  facts: SessionAccessorSyntaxFacts,
) {
  const violations = findNamedBoundaryViolations(
    facts,
    embeddedAgentSessionFileRuntimeNames,
    "legacy embedded-agent session file resolver",
  );

  const recordDeprecatedSessionFile = (name: ts.Node) => {
    violations.push({
      line: toLine(facts.sourceFile, name),
      reason:
        'passes deprecated embedded-agent runtime identity field "sessionFile"; use sessionTarget',
    });
  };

  const visitRunOptions = (options: ts.ObjectLiteralExpression) => {
    for (const property of options.properties) {
      if (
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        getPropertyNameText(property.name) === "sessionFile"
      ) {
        recordDeprecatedSessionFile(property.name);
      }
    }
  };

  for (const call of facts.embeddedAgentCalls) {
    const firstArgument = call.arguments[0];
    const options = firstArgument ? unwrapExpression(firstArgument) : undefined;
    if (options && ts.isObjectLiteralExpression(options)) {
      visitRunOptions(options);
    }
  }
  return violations;
}

export function findSessionAccessorWriteBoundaryViolations(
  _content: string,
  fileName: string,
  facts: SessionAccessorSyntaxFacts,
) {
  return findNamedBoundaryViolations(facts, legacyWriterNames, "legacy session store writer", {
    // These owners forward released SDK callbacks; internal calls remain forbidden.
    import: (declaration, specifier) =>
      ts.isStringLiteral(declaration.moduleSpecifier) &&
      declaration.moduleSpecifier.text === "../../plugin-sdk/session-store-runtime.js" &&
      !specifier.propertyName &&
      ((specifier.name.text === "updateLastRoute" &&
        (fileName === "src/plugins/runtime/runtime-channel.ts" ||
          fileName.endsWith("/src/plugins/runtime/runtime-channel.ts"))) ||
        (specifier.name.text === "updateSessionStoreEntry" &&
          (fileName === "src/plugins/runtime/runtime-agent.ts" ||
            fileName.endsWith("/src/plugins/runtime/runtime-agent.ts")))),
    reference: (node) =>
      (fileName === "src/plugins/registry-runtime-channel.ts" ||
        fileName.endsWith("/src/plugins/registry-runtime-channel.ts")) &&
      node.name.text === "updateLastRoute" &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "session" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "channel",
  });
}

export const findTranscriptWriterBoundaryViolations = namedBoundaryRule(
  legacyTranscriptWriterNames,
  "legacy transcript writer",
);

export function findGatewaySessionCreateLifecycleViolations(
  _content: string,
  _fileName: string,
  facts: SessionAccessorSyntaxFacts,
) {
  return facts.createHandlerCalls
    .filter(({ name }) => name === "updateSessionStoreEntry")
    .map(({ node, name }) => ({
      line: toLine(facts.sourceFile, node.expression),
      reason: `calls legacy sessions.create lifecycle writer "${name}"`,
    }));
}

export const findSessionLifecycleCleanupBoundaryViolations = namedBoundaryRule(
  legacyLifecycleCleanupNames,
  "legacy session store lifecycle cleanup",
);

// Source roots shared by the enforced boundary checks in main() and the debt
// ratchet below; keeping one list prevents the two scans from drifting apart.
const readSourceRootPaths = [
  "packages/memory-host-sdk/src/host",
  "extensions/discord/src/monitor",
  "extensions/memory-core/src",
  "extensions/telegram/src",
  "extensions/voice-call/src",
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
];
const writeSourceRootPaths = [
  "src/acp",
  "src/agents",
  "src/auto-reply",
  "src/commands",
  "src/config/sessions",
  "src/gateway",
  "src/infra",
  "src/plugins",
  "src/tui",
];
const transcriptWriterSourceRootPaths = [
  "src/agents/command",
  "src/agents/embedded-agent-runner",
  "src/auto-reply/reply",
  "src/config/sessions",
  "src/gateway/server-methods",
  "src/sessions",
];

function collectTopLevelFunctionBodies(sourceFile: ts.SourceFile) {
  const bodies = new Map<string, ts.ConciseBody>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name && statement.body) {
        bodies.set(statement.name.text, statement.body);
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const declaration = statement.declarationList.declarations[0];
    const initializer = declaration?.initializer;
    if (
      declaration &&
      ts.isIdentifier(declaration.name) &&
      initializer &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ) {
      bodies.set(declaration.name.text, initializer.body);
    }
  }
  return bodies;
}

export function findMemoryHostSessionCorpusBoundaryViolations(
  _content: string,
  _fileName: string,
  facts: SessionAccessorSyntaxFacts,
) {
  const functionBodies = collectTopLevelFunctionBodies(facts.sourceFile);
  const visitedFunctions = new Set<string>();
  const violationKeys = new Set<string>();
  const violations: BoundaryViolation[] = [];

  const visitCorpusBody = (body: ts.Node) => {
    for (const { node, name: calleeName, direct } of facts.calls) {
      if (node.pos < body.pos || node.end > body.end) {
        continue;
      }
      if (calleeName && legacyMemoryHostSessionCorpusNames.has(calleeName)) {
        const line = toLine(facts.sourceFile, node.expression);
        const reason = `calls legacy memory-host session corpus helper "${calleeName}"`;
        const key = `${line}:${reason}`;
        if (!violationKeys.has(key)) {
          violationKeys.add(key);
          violations.push({ line, reason });
        }
      }
      if (calleeName && direct) {
        const localBody = functionBodies.get(calleeName);
        if (localBody && !visitedFunctions.has(calleeName)) {
          visitedFunctions.add(calleeName);
          visitCorpusBody(localBody);
        }
      }
    }
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

// Debt ratchet: the boundary checks above only scan files already on the
// migrated lists, so unmigrated files could quietly gain new legacy call
// sites. The checked-in baseline locks each unmigrated file's current legacy
// call-site count per concern; any drift from the baseline fails the guard.
const sessionAccessorDebtBaselineRelativePath = "scripts/lib/session-accessor-debt-baseline.json";
const debtBaselineRegenCommand = "pnpm lint:tmp:session-accessor-boundary:gen";

// Keys sorted alphabetically so the generated baseline JSON stays deterministic.
const sessionAccessorDebtConcerns = {
  embeddedAgentSessionTarget: {
    sourceRootPaths: ["extensions/voice-call/src"],
    migratedFiles: migratedEmbeddedAgentSessionTargetFiles,
    findViolations: findEmbeddedAgentSessionTargetViolations,
  },
  memoryHostSessionCorpus: {
    sourceRootPaths: ["packages/memory-host-sdk/src/host"],
    migratedFiles: migratedMemoryHostSessionCorpusFiles,
    findViolations: findMemoryHostSessionCorpusBoundaryViolations,
  },
  sessionAccessorRead: {
    sourceRootPaths: readSourceRootPaths,
    migratedFiles: new Set([
      ...migratedSessionAccessorFiles,
      ...migratedBundledPluginSessionAccessorFiles,
    ]),
    findViolations: findSessionAccessorBoundaryViolations,
  },
  sessionAccessorWrite: {
    sourceRootPaths: writeSourceRootPaths,
    migratedFiles: migratedSessionAccessorWriteFiles,
    findViolations: findSessionAccessorWriteBoundaryViolations,
  },
  sessionLifecycleCleanup: {
    sourceRootPaths: readSourceRootPaths,
    migratedFiles: migratedSessionLifecycleCleanupFiles,
    findViolations: findSessionLifecycleCleanupBoundaryViolations,
  },
  transcriptWriter: {
    sourceRootPaths: transcriptWriterSourceRootPaths,
    migratedFiles: migratedTranscriptWriterFiles,
    findViolations: findTranscriptWriterBoundaryViolations,
  },
};

function sortRecordByKey<Value>(record: Record<string, Value>) {
  return Object.fromEntries(
    Object.entries(record).toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

export async function collectSessionAccessorFindings(repoRoot: string) {
  const enforcementConcerns = [
    sessionAccessorDebtConcerns.sessionAccessorRead,
    sessionAccessorDebtConcerns.sessionAccessorWrite,
    sessionAccessorDebtConcerns.transcriptWriter,
    {
      sourceRootPaths: ["src/gateway/server-methods"],
      migratedFiles: new Set(["src/gateway/server-methods/sessions-create.ts"]),
      findViolations: findGatewaySessionCreateLifecycleViolations,
    },
    sessionAccessorDebtConcerns.sessionLifecycleCleanup,
    sessionAccessorDebtConcerns.memoryHostSessionCorpus,
    sessionAccessorDebtConcerns.embeddedAgentSessionTarget,
    {
      sourceRootPaths: ["src/gateway"],
      migratedFiles: readOnlyGatewaySessionAccessorFiles,
      findViolations: findReadOnlySessionAccessorViolations,
    },
    {
      sourceRootPaths: ["src/plugin-sdk"],
      migratedFiles: new Set(["src/plugin-sdk/session-store-runtime.ts"]),
      findViolations: findSessionStoreRuntimeFileBackedCompatExportViolations,
    },
  ];
  const enforcement = enforcementConcerns.map(
    () => [] as Array<BoundaryViolation & { path: string }>,
  );
  const counts: SessionAccessorDebtCounts = Object.fromEntries(
    Object.keys(sessionAccessorDebtConcerns).map((key) => [key, {}]),
  );
  const roots = [
    ...new Set([
      ...Object.values(sessionAccessorDebtConcerns).flatMap((concern) => concern.sourceRootPaths),
      ...enforcementConcerns.flatMap((concern) => [...concern.migratedFiles]),
    ]),
  ];
  // Broad roots subsume narrow roots and explicit migrated files. The shared
  // collector keeps only a batch of trees; facts live for one file, not the corpus.
  const sourceRoots = roots.filter(
    (root) => !roots.some((other) => other !== root && root.startsWith(`${other}/`)),
  );
  await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, sourceRoots),
    findViolations: (content, fileName, sourceFile) => {
      const filePath = path.relative(repoRoot, fileName);
      const relativePath = normalizeRelativePath(filePath);
      const facts = collectSessionAccessorSyntaxFacts(sourceFile);
      for (const [index, concern] of enforcementConcerns.entries()) {
        if (concern.migratedFiles.has(relativePath)) {
          for (const violation of concern.findViolations(content, fileName, facts)) {
            enforcement[index]!.push({ path: filePath, ...violation });
          }
        }
      }
      for (const [key, concern] of Object.entries(sessionAccessorDebtConcerns)) {
        if (
          concern.migratedFiles.has(relativePath) ||
          !concern.sourceRootPaths.some((root) => relativePath.startsWith(`${root}/`))
        ) {
          continue;
        }
        const count = concern.findViolations(content, fileName, facts).length;
        if (count) {
          counts[key]![relativePath] = count;
        }
      }
      return [];
    },
  });
  return {
    violations: enforcement.flatMap((violations, index) =>
      violations.toSorted((left, right) =>
        compareMigratedFilePaths(
          normalizeRelativePath(left.path),
          normalizeRelativePath(right.path),
          enforcementConcerns[index]!.sourceRootPaths,
        ),
      ),
    ),
    counts: sortRecordByKey(
      Object.fromEntries(
        Object.entries(counts).map(([key, files]) => [key, sortRecordByKey(files)]),
      ),
    ),
  };
}

export function compareSessionAccessorDebt(
  currentCounts: SessionAccessorDebtCounts,
  baselineCounts: SessionAccessorDebtCounts,
) {
  const regressions = [];
  const improvements = [];
  const concerns = [
    ...new Set([...Object.keys(baselineCounts), ...Object.keys(currentCounts)]),
  ].toSorted();
  for (const concern of concerns) {
    const current = currentCounts[concern] ?? {};
    const baseline = baselineCounts[concern] ?? {};
    const filePaths = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].toSorted();
    for (const filePath of filePaths) {
      const currentCount = current[filePath] ?? 0;
      const baselineCount = baseline[filePath] ?? 0;
      if (currentCount === baselineCount) {
        continue;
      }
      const entry = { concern, path: filePath, currentCount, baselineCount };
      if (currentCount > baselineCount) {
        regressions.push(entry);
      } else {
        improvements.push(entry);
      }
    }
  }
  return { regressions, improvements };
}
type DebtComparison = ReturnType<typeof compareSessionAccessorDebt>;

// Improvements fail the guard too: passing silently would leave the baseline
// stale, letting a later change reintroduce legacy call sites up to the old
// count without tripping the ratchet.
export function formatSessionAccessorDebtImprovements(
  improvements: DebtComparison["improvements"],
) {
  return [
    `Legacy session accessor debt dropped below ${sessionAccessorDebtBaselineRelativePath}:`,
    ...improvements.map(
      (improvement) =>
        `- ${improvement.path} [${improvement.concern}]: ${improvement.currentCount} legacy call site(s), stale baseline allows ${improvement.baselineCount}`,
    ),
    `Run \`${debtBaselineRegenCommand}\` to ratchet the baseline down and commit it.`,
  ];
}

function resolveDebtBaselinePath(repoRoot: string) {
  return path.join(repoRoot, ...sessionAccessorDebtBaselineRelativePath.split("/"));
}

async function readSessionAccessorDebtBaseline(repoRoot: string) {
  try {
    return sessionAccessorDebtCountsSchema.parse(
      JSON.parse(await fs.readFile(resolveDebtBaselinePath(repoRoot), "utf8")),
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSessionAccessorDebtBaseline(repoRoot: string) {
  const { counts } = await collectSessionAccessorFindings(repoRoot);
  await fs.writeFile(resolveDebtBaselinePath(repoRoot), `${JSON.stringify(counts, null, 2)}\n`);
}

function compareMigratedFilePaths(left: string, right: string, sourceRootPaths: string[]) {
  const rootIndex = (filePath: string) =>
    sourceRootPaths.findIndex((sourceRoot) => filePath.startsWith(`${sourceRoot}/`));
  const leftRoot = rootIndex(left);
  const rightRoot = rootIndex(right);
  const rootOrder =
    (leftRoot < 0 ? sourceRootPaths.length : leftRoot) -
    (rightRoot < 0 ? sourceRootPaths.length : rightRoot);
  if (rootOrder !== 0) {
    return rootOrder;
  }
  // Recursive directory walks visit nested files before same-prefix sibling files.
  const leftTraversalPath = left.replaceAll("/", "\0");
  const rightTraversalPath = right.replaceAll("/", "\0");
  return leftTraversalPath < rightTraversalPath
    ? -1
    : leftTraversalPath > rightTraversalPath
      ? 1
      : 0;
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  if (process.argv.includes("--update-debt-baseline")) {
    await writeSessionAccessorDebtBaseline(repoRoot);
    console.log(`Wrote ${sessionAccessorDebtBaselineRelativePath}`);
    return;
  }
  const { violations, counts } = await collectSessionAccessorFindings(repoRoot);

  const baselineCounts = await readSessionAccessorDebtBaseline(repoRoot);
  if (!baselineCounts) {
    console.error(
      `Missing ${sessionAccessorDebtBaselineRelativePath}; run \`${debtBaselineRegenCommand}\` and commit it.`,
    );
    process.exitCode = 1;
    return;
  }
  const debt = compareSessionAccessorDebt(counts, baselineCounts);

  if (violations.length === 0 && debt.regressions.length === 0 && debt.improvements.length === 0) {
    console.log("session accessor boundary guard passed.");
    return;
  }

  if (violations.length > 0) {
    console.error("Found legacy session store usage in session-accessor migrated files:");
    for (const violation of violations) {
      console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
    }
    console.error(
      "Use src/config/sessions/session-accessor.ts helpers for migrated read/write and transcript-writer paths. Expand file-backed SDK compatibility only as an explicit pre-SQLite migration decision.",
    );
  }
  if (debt.regressions.length > 0) {
    console.error(
      `Found new legacy session call sites in unmigrated files (counts exceed ${sessionAccessorDebtBaselineRelativePath}):`,
    );
    for (const regression of debt.regressions) {
      console.error(
        `- ${regression.path} [${regression.concern}]: ${regression.currentCount} legacy call site(s), baseline allows ${regression.baselineCount}`,
      );
    }
    console.error(
      `Use src/config/sessions/session-accessor.ts helpers instead of adding legacy call sites. If the increase is an intentional seam-owner change, run \`${debtBaselineRegenCommand}\` and commit the updated baseline.`,
    );
  }
  if (debt.improvements.length > 0) {
    for (const line of formatSessionAccessorDebtImprovements(debt.improvements)) {
      console.error(line);
    }
  }
  process.exitCode = 1;
}

runAsScript(import.meta.url, main);
