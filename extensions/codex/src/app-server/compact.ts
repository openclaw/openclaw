import { createHash } from "node:crypto";
import path from "node:path";
import {
  embeddedAgentLog,
  type CompactEmbeddedPiSessionParams,
  type EmbeddedPiCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  defaultCodexAppServerClientFactory,
  type CodexAppServerClientFactory,
} from "./client-factory.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import {
  CodexNativeThreadLifecycleReason,
  emitCodexNativeThreadLifecycleDiagnostic,
  resolveCodexNativeThreadBindingMode,
  type CodexNativeThreadLifecycleDiagnostic,
  type CodexNativeThreadLifecycleDiagnosticInput,
} from "./native-thread-diagnostics.js";
import type { JsonObject, JsonValue } from "./protocol.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

const warnedIgnoredCompactionOverrides = new Set<string>();

function codexNativeBindingDiagnosticFields(
  binding: CodexAppServerThreadBinding | undefined,
): Partial<CodexNativeThreadLifecycleDiagnostic> {
  return {
    threadId: binding?.threadId,
    bindingMode: resolveCodexNativeThreadBindingMode(binding),
    contextEngineId: binding?.contextEngine?.engineId,
    contextEnginePolicyFingerprint: binding?.contextEngine?.policyFingerprint,
    projectionMode: binding?.contextEngine?.projection?.mode,
    projectionEpoch: binding?.contextEngine?.projection?.epoch,
    projectionFingerprint: binding?.contextEngine?.projection?.fingerprint,
    dynamicToolsFingerprint: binding?.dynamicToolsFingerprint,
    userMcpServersFingerprint: binding?.userMcpServersFingerprint,
    mcpServersFingerprint: binding?.mcpServersFingerprint,
    environmentSelectionFingerprint: binding?.environmentSelectionFingerprint,
    pluginAppsFingerprint: binding?.pluginAppsFingerprint,
    pluginAppsInputFingerprint: binding?.pluginAppsInputFingerprint,
  };
}

function emitCodexNativeThreadCompactionDiagnostic(
  params: CompactEmbeddedPiSessionParams,
  diagnostic: CodexNativeThreadLifecycleDiagnosticInput,
): void {
  emitCodexNativeThreadLifecycleDiagnostic({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    contextTokenBudget: params.contextTokenBudget,
    sessionTokens: params.currentTokenCount,
    ...diagnostic,
  });
}

type PreservableContextEngineThreadBootstrapBinding = CodexAppServerThreadBinding & {
  contextEngine: NonNullable<CodexAppServerThreadBinding["contextEngine"]> & {
    projection: NonNullable<
      NonNullable<CodexAppServerThreadBinding["contextEngine"]>["projection"]
    >;
  };
};

function isPreservableContextEngineThreadBootstrapBinding(
  binding: CodexAppServerThreadBinding | undefined,
): binding is PreservableContextEngineThreadBootstrapBinding {
  return binding?.contextEngine?.projection?.mode === "thread_bootstrap";
}

export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedPiSessionParams,
  options: { pluginConfig?: unknown; clientFactory?: CodexAppServerClientFactory } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  warnIfIgnoringOpenClawCompactionOverrides(params);
  // Codex owns automatic context-pressure compaction for Codex runtime sessions.
  // This entry point is only for explicit/manual compaction requests. OpenClaw
  // starts native Codex compaction for the bound thread and returns immediately;
  // Codex reports and applies the compaction inside its own app-server session.
  return compactCodexNativeThread(params, options);
}

export async function reconcileContextEngineCompactedCodexBinding({
  params,
  contextEngineId,
  compactedSessionId,
  compactedSessionFile,
  originalBinding: originalBindingSnapshot,
}: {
  params: CompactEmbeddedPiSessionParams;
  contextEngineId: string;
  compactedSessionId: string;
  compactedSessionFile: string;
  originalBinding?: CodexAppServerThreadBinding | null;
}): Promise<{ invalidated: boolean; preserved: boolean; successorInvalidated: boolean }> {
  const rolledOver = compactedSessionFile !== params.sessionFile;
  const originalBinding = sanitizePreservedCodexBinding(
    originalBindingSnapshot === null
      ? undefined
      : (originalBindingSnapshot ??
          (await readCodexAppServerBinding(params.sessionFile, {
            config: params.config,
          }))),
  );
  let preInvalidatedSuccessorBinding = false;
  if (rolledOver) {
    const rawSuccessorBinding = await readCodexAppServerBinding(compactedSessionFile, {
      config: params.config,
    });
    const successorBinding = sanitizePreservedCodexBinding(rawSuccessorBinding);
    if (isPreservableContextEngineThreadBootstrapBinding(successorBinding)) {
      const equivalentToOriginal = originalBinding?.threadId
        ? areCodexBindingsEquivalentForCompactionPreservation(successorBinding, originalBinding)
        : true;
      if (!equivalentToOriginal && originalBinding) {
        preInvalidatedSuccessorBinding = true;
        emitCodexNativeThreadCompactionDiagnostic(params, {
          action: "invalidated",
          reason: CodexNativeThreadLifecycleReason.ContextEngineCompactionInvalidatedBinding,
          level: "info",
          message:
            "context-engine-owned Codex app-server compaction replaced original native thread binding with successor bootstrap binding",
          sessionId: params.sessionId,
          successorSessionId: compactedSessionId,
          sessionFile: describeSessionFileForDiagnostic(params.sessionFile),
          successorSessionFile: describeSessionFileForDiagnostic(compactedSessionFile),
          compactionRolledOver: true,
          ...codexNativeBindingDiagnosticFields(originalBinding),
          contextEngineId: originalBinding.contextEngine?.engineId ?? contextEngineId,
          contextEnginePolicyFingerprint: originalBinding.contextEngine?.policyFingerprint,
          contextEngineProjectionContributed: Boolean(originalBinding.contextEngine),
        });
        await clearCodexAppServerBinding(compactedSessionFile, { config: params.config });
      } else {
        if (bindingHasUnsanitizedPreservedComparisonFields(rawSuccessorBinding)) {
          await writeCodexAppServerBinding(compactedSessionFile, successorBinding, {
            config: params.config,
          });
        }
        await clearCodexAppServerBinding(params.sessionFile, { config: params.config });
        emitCodexNativeThreadCompactionDiagnostic(params, {
          action: "preserved",
          reason: CodexNativeThreadLifecycleReason.ContextEngineCompactionPreservedBinding,
          level: "info",
          message:
            "context-engine-owned Codex app-server compaction preserved successor native thread-bootstrap binding",
          sessionId: compactedSessionId,
          previousSessionId: params.sessionId,
          sessionFile: describeSessionFileForDiagnostic(compactedSessionFile),
          previousSessionFile: describeSessionFileForDiagnostic(params.sessionFile),
          successorSessionFile: describeSessionFileForDiagnostic(compactedSessionFile),
          successorSessionId: compactedSessionId,
          compactionRolledOver: true,
          ...codexNativeBindingDiagnosticFields(successorBinding),
          contextEngineId: successorBinding.contextEngine?.engineId ?? contextEngineId,
          contextEnginePolicyFingerprint: successorBinding.contextEngine?.policyFingerprint,
          contextEngineProjectionContributed: true,
          semanticReuse: true,
        });
        return {
          invalidated: false,
          preserved: true,
          successorInvalidated: false,
        };
      }
    }
  }
  if (isPreservableContextEngineThreadBootstrapBinding(originalBinding)) {
    let invalidated = false;
    let successorInvalidated = preInvalidatedSuccessorBinding;
    if (rolledOver) {
      const rawSuccessorBinding = await readCodexAppServerBinding(compactedSessionFile, {
        config: params.config,
      });
      const successorBinding = sanitizePreservedCodexBinding(rawSuccessorBinding);
      successorInvalidated =
        Boolean(successorBinding?.threadId) &&
        !areCodexBindingsEquivalentForCompactionPreservation(successorBinding, originalBinding);
      if (successorInvalidated && successorBinding) {
        emitCodexNativeThreadCompactionDiagnostic(params, {
          action: "invalidated",
          reason: CodexNativeThreadLifecycleReason.ContextEngineCompactionInvalidatedBinding,
          level: "info",
          message:
            "context-engine-owned Codex app-server compaction replaced successor native thread binding with preserved bootstrap binding",
          sessionId: compactedSessionId,
          previousSessionId: params.sessionId,
          sessionFile: describeSessionFileForDiagnostic(compactedSessionFile),
          previousSessionFile: describeSessionFileForDiagnostic(params.sessionFile),
          compactionRolledOver: true,
          ...codexNativeBindingDiagnosticFields(successorBinding),
          contextEngineId: successorBinding.contextEngine?.engineId ?? contextEngineId,
          contextEnginePolicyFingerprint: successorBinding.contextEngine?.policyFingerprint,
          contextEngineProjectionContributed: Boolean(successorBinding.contextEngine),
        });
      }
      await writeCodexAppServerBinding(compactedSessionFile, originalBinding, {
        config: params.config,
      });
      await clearCodexAppServerBinding(params.sessionFile, { config: params.config });
    } else {
      const rawCurrentBinding = await readCodexAppServerBinding(params.sessionFile, {
        config: params.config,
      });
      const currentBinding = sanitizePreservedCodexBinding(rawCurrentBinding);
      const currentBindingChanged =
        Boolean(currentBinding?.threadId) &&
        !areCodexBindingsEquivalentForCompactionPreservation(currentBinding, originalBinding);
      if (currentBindingChanged && currentBinding) {
        invalidated = true;
        emitCodexNativeThreadCompactionDiagnostic(params, {
          action: "invalidated",
          reason: CodexNativeThreadLifecycleReason.ContextEngineCompactionInvalidatedBinding,
          level: "info",
          message:
            "context-engine-owned Codex app-server compaction replaced changed native thread binding with preserved bootstrap binding",
          sessionId: compactedSessionId,
          previousSessionId: params.sessionId,
          sessionFile: describeSessionFileForDiagnostic(params.sessionFile),
          previousSessionFile: describeSessionFileForDiagnostic(params.sessionFile),
          compactionRolledOver: false,
          ...codexNativeBindingDiagnosticFields(currentBinding),
          contextEngineId: currentBinding.contextEngine?.engineId ?? contextEngineId,
          contextEnginePolicyFingerprint: currentBinding.contextEngine?.policyFingerprint,
          contextEngineProjectionContributed: Boolean(currentBinding.contextEngine),
        });
      }
      if (
        !areCodexBindingsEquivalentForCompactionPreservation(currentBinding, originalBinding) ||
        bindingHasUnsanitizedPreservedComparisonFields(rawCurrentBinding)
      ) {
        await writeCodexAppServerBinding(params.sessionFile, originalBinding, {
          config: params.config,
        });
      }
    }
    emitCodexNativeThreadCompactionDiagnostic(params, {
      action: "preserved",
      reason: CodexNativeThreadLifecycleReason.ContextEngineCompactionPreservedBinding,
      level: "info",
      message:
        "context-engine-owned Codex app-server compaction preserved native thread-bootstrap binding",
      sessionId: compactedSessionId,
      previousSessionId: params.sessionId,
      sessionFile: describeSessionFileForDiagnostic(compactedSessionFile),
      previousSessionFile: describeSessionFileForDiagnostic(params.sessionFile),
      successorSessionFile: rolledOver
        ? describeSessionFileForDiagnostic(compactedSessionFile)
        : undefined,
      successorSessionId: rolledOver ? compactedSessionId : undefined,
      compactionRolledOver: rolledOver,
      ...codexNativeBindingDiagnosticFields(originalBinding),
      contextEngineId: originalBinding.contextEngine?.engineId ?? contextEngineId,
      contextEnginePolicyFingerprint: originalBinding.contextEngine?.policyFingerprint,
      contextEngineProjectionContributed: true,
      semanticReuse: true,
    });
    return {
      invalidated: invalidated || successorInvalidated,
      preserved: true,
      successorInvalidated,
    };
  }

  let invalidated = false;
  let successorInvalidated = preInvalidatedSuccessorBinding;
  if (originalBinding?.threadId) {
    invalidated = true;
    emitCodexNativeThreadCompactionDiagnostic(params, {
      action: "invalidated",
      reason: CodexNativeThreadLifecycleReason.ContextEngineCompactionInvalidatedBinding,
      level: "info",
      message: "context-engine-owned Codex app-server compaction invalidated native thread binding",
      sessionFile: describeSessionFileForDiagnostic(params.sessionFile),
      successorSessionFile: rolledOver
        ? describeSessionFileForDiagnostic(compactedSessionFile)
        : undefined,
      successorSessionId: rolledOver ? compactedSessionId : undefined,
      compactionRolledOver: rolledOver,
      ...codexNativeBindingDiagnosticFields(originalBinding),
      contextEngineId: originalBinding.contextEngine?.engineId ?? contextEngineId,
      contextEnginePolicyFingerprint: originalBinding.contextEngine?.policyFingerprint,
      contextEngineProjectionContributed: Boolean(originalBinding.contextEngine),
    });
  }
  await clearCodexAppServerBinding(params.sessionFile, { config: params.config });
  if (rolledOver) {
    const compactedBinding = sanitizePreservedCodexBinding(
      await readCodexAppServerBinding(compactedSessionFile, {
        config: params.config,
      }),
    );
    if (compactedBinding?.threadId) {
      invalidated = true;
      successorInvalidated = true;
      emitCodexNativeThreadCompactionDiagnostic(params, {
        action: "invalidated",
        reason: CodexNativeThreadLifecycleReason.ContextEngineCompactionInvalidatedBinding,
        level: "info",
        message:
          "context-engine-owned Codex app-server compaction invalidated successor native thread binding",
        sessionId: compactedSessionId,
        previousSessionId: params.sessionId,
        sessionFile: describeSessionFileForDiagnostic(compactedSessionFile),
        previousSessionFile: describeSessionFileForDiagnostic(params.sessionFile),
        compactionRolledOver: true,
        ...codexNativeBindingDiagnosticFields(compactedBinding),
        contextEngineId: compactedBinding.contextEngine?.engineId ?? contextEngineId,
        contextEnginePolicyFingerprint: compactedBinding.contextEngine?.policyFingerprint,
        contextEngineProjectionContributed: Boolean(compactedBinding.contextEngine),
      });
    }
    await clearCodexAppServerBinding(compactedSessionFile, { config: params.config });
  }
  return { invalidated, preserved: false, successorInvalidated };
}

function areCodexBindingsEquivalentForCompactionPreservation(
  left: CodexAppServerThreadBinding | undefined,
  right: CodexAppServerThreadBinding,
): boolean {
  if (!left?.threadId) {
    return false;
  }
  return (
    left.threadId === right.threadId &&
    left.cwd === right.cwd &&
    left.authProfileId === right.authProfileId &&
    left.model === right.model &&
    left.modelProvider === right.modelProvider &&
    left.approvalPolicy === right.approvalPolicy &&
    left.sandbox === right.sandbox &&
    left.serviceTier === right.serviceTier &&
    left.dynamicToolsFingerprint === right.dynamicToolsFingerprint &&
    left.userMcpServersFingerprint === right.userMcpServersFingerprint &&
    left.mcpServersFingerprint === right.mcpServersFingerprint &&
    left.pluginAppsFingerprint === right.pluginAppsFingerprint &&
    left.pluginAppsInputFingerprint === right.pluginAppsInputFingerprint &&
    left.environmentSelectionFingerprint === right.environmentSelectionFingerprint &&
    stableJson(left.pluginAppPolicyContext) === stableJson(right.pluginAppPolicyContext) &&
    stableJson(left.contextEngine) === stableJson(right.contextEngine)
  );
}

function sanitizePreservedCodexBinding(
  binding: CodexAppServerThreadBinding | undefined,
): CodexAppServerThreadBinding | undefined {
  if (!binding) {
    return undefined;
  }
  return {
    ...binding,
    userMcpServersFingerprint: sanitizePreservedComparisonFingerprint(
      "userMcpServersFingerprint",
      binding.userMcpServersFingerprint,
    ),
    environmentSelectionFingerprint: sanitizePreservedComparisonFingerprint(
      "environmentSelectionFingerprint",
      binding.environmentSelectionFingerprint,
    ),
  };
}

function bindingHasUnsanitizedPreservedComparisonFields(
  binding: CodexAppServerThreadBinding | undefined,
): boolean {
  return Boolean(
    binding &&
    (isUnsanitizedPreservedComparisonFingerprint(binding.userMcpServersFingerprint) ||
      isUnsanitizedPreservedComparisonFingerprint(binding.environmentSelectionFingerprint)),
  );
}

function sanitizePreservedComparisonFingerprint(
  key: "userMcpServersFingerprint" | "environmentSelectionFingerprint",
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!isUnsanitizedPreservedComparisonFingerprint(value)) {
    return value;
  }
  const parsed = parseStoredJsonValue(value);
  if (parsed !== undefined) {
    return fingerprintStableJsonValue(resolvePreservedComparisonFingerprintNamespace(key), parsed);
  }
  return fingerprintStoredComparisonString(key, value);
}

function isUnsanitizedPreservedComparisonFingerprint(value: string | undefined): boolean {
  return Boolean(value && !/^sha256:[a-f0-9]{64}$/iu.test(value));
}

function parseStoredJsonValue(value: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function fingerprintStableJsonValue(namespace: string, value: JsonValue): string {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(JSON.stringify(stabilizeJsonValue(value)));
  return `sha256:${hash.digest("hex")}`;
}

function fingerprintStoredComparisonString(key: string, value: string): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:preserved-binding-fingerprint:v1");
  hash.update("\0");
  hash.update(key);
  hash.update("\0");
  hash.update(value);
  return `sha256:${hash.digest("hex")}`;
}

function resolvePreservedComparisonFingerprintNamespace(
  key: "userMcpServersFingerprint" | "environmentSelectionFingerprint",
): string {
  return key === "userMcpServersFingerprint"
    ? "openclaw:codex:user-mcp-servers:v1"
    : "openclaw:codex:environment-selection:v1";
}

function stabilizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    stable[key] = stabilizeJsonValue(child);
  }
  return stable;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function describeSessionFileForDiagnostic(sessionFile: string | undefined): string | undefined {
  if (!sessionFile?.trim()) {
    return undefined;
  }
  return path.basename(sessionFile);
}

function warnIfIgnoringOpenClawCompactionOverrides(params: CompactEmbeddedPiSessionParams): void {
  const ignoredConfig = readIgnoredCompactionOverridePaths(params);
  if (ignoredConfig.length === 0) {
    return;
  }
  const warningKey = ignoredConfig.join("\0");
  if (warnedIgnoredCompactionOverrides.has(warningKey)) {
    return;
  }
  warnedIgnoredCompactionOverrides.add(warningKey);
  embeddedAgentLog.warn(
    "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ignoredConfig,
    },
  );
}

function readIgnoredCompactionOverridePaths(params: CompactEmbeddedPiSessionParams): string[] {
  const ignored = new Set<string>();
  for (const entry of readCompactionOverrideEntries(params)) {
    const localProvider =
      typeof entry.record.provider === "string" ? entry.record.provider.trim() : "";
    const inheritedProvider =
      !localProvider && typeof entry.inheritedRecord?.provider === "string"
        ? entry.inheritedRecord.provider.trim()
        : "";
    const providerPath = localProvider
      ? `${entry.path}.compaction.provider`
      : inheritedProvider && entry.inheritedPath
        ? `${entry.inheritedPath}.compaction.provider`
        : undefined;
    if (typeof entry.record.model === "string" && entry.record.model.trim()) {
      ignored.add(`${entry.path}.compaction.model`);
    }
    if (providerPath) {
      ignored.add(providerPath);
    }
  }
  return [...ignored];
}

function readCompactionOverrideEntries(params: CompactEmbeddedPiSessionParams): Array<{
  path: string;
  record: Record<string, unknown>;
  inheritedRecord?: Record<string, unknown>;
  inheritedPath?: string;
}> {
  const entries: Array<{
    path: string;
    record: Record<string, unknown>;
    inheritedRecord?: Record<string, unknown>;
    inheritedPath?: string;
  }> = [];
  const defaultCompaction = readRecord(readRecord(params.config?.agents)?.defaults)?.compaction;
  const defaultRecord = readRecord(defaultCompaction);
  if (defaultRecord) {
    entries.push({ path: "agents.defaults", record: defaultRecord });
  }
  const agentId = readAgentIdFromSessionKey(params.sessionKey ?? params.sandboxSessionKey);
  if (!agentId) {
    return entries;
  }
  const agents = Array.isArray(params.config?.agents?.list) ? params.config.agents.list : [];
  const activeAgent = agents.find((agent) => {
    const id = typeof agent?.id === "string" ? agent.id.trim().toLowerCase() : "";
    return id === agentId;
  });
  const agentCompaction = readRecord(activeAgent)?.compaction;
  const agentRecord = readRecord(agentCompaction);
  if (agentRecord) {
    entries.push({
      path: `agents.list.${agentId}`,
      record: agentRecord,
      inheritedRecord: defaultRecord,
      inheritedPath: "agents.defaults",
    });
  }
  return entries;
}

function readAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const parts = sessionKey?.trim().toLowerCase().split(":").filter(Boolean) ?? [];
  if (parts.length < 3 || parts[0] !== "agent") {
    return undefined;
  }
  return parts[1]?.trim() || undefined;
}

async function compactCodexNativeThread(
  params: CompactEmbeddedPiSessionParams,
  options: { pluginConfig?: unknown; clientFactory?: CodexAppServerClientFactory } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  if (params.trigger !== "manual") {
    embeddedAgentLog.info("skipping codex app-server compaction for non-manual trigger", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      trigger: params.trigger,
    });
    return {
      ok: true,
      compacted: false,
      reason: "codex app-server owns automatic compaction",
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: params.currentTokenCount ?? 0,
        details: {
          backend: "codex-app-server",
          skipped: true,
          reason: "non_manual_trigger",
          trigger: params.trigger ?? "unknown",
        },
      },
    };
  }
  const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
    config: params.config,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
    surface: "native compaction",
  });
  if (nativeExecutionBlock) {
    return { ok: false, compacted: false, reason: nativeExecutionBlock };
  }
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const binding = await readCodexAppServerBinding(params.sessionFile, { config: params.config });
  if (!binding?.threadId) {
    return failedCodexThreadBindingCompactionResult(params, {
      reason: "no codex app-server thread binding",
      recovery: "missing_thread_binding",
    });
  }
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  if (
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    emitCodexNativeThreadCompactionDiagnostic(params, {
      action: "failed",
      reason: CodexNativeThreadLifecycleReason.AuthProfileMismatch,
      level: "warn",
      message: "codex app-server compaction rejected thread binding for auth profile mismatch",
      ...codexNativeBindingDiagnosticFields(binding),
      extra: {
        requestedAuthProfileId,
        bindingAuthProfileId: binding.authProfileId,
      },
    });
    return { ok: false, compacted: false, reason: "auth profile mismatch for session binding" };
  }

  const clientFactory = options.clientFactory ?? defaultCodexAppServerClientFactory;
  const client = await clientFactory(
    appServer.start,
    requestedAuthProfileId ?? binding.authProfileId,
    params.agentDir,
    params.config,
  );
  try {
    await client.request("thread/compact/start", {
      threadId: binding.threadId,
    });
    embeddedAgentLog.info("started codex app-server compaction", {
      sessionId: params.sessionId,
      threadId: binding.threadId,
    });
  } catch (error) {
    if (isCodexThreadNotFoundError(error)) {
      return failedCodexThreadBindingCompactionResult(params, {
        binding,
        threadId: binding.threadId,
        reason: formatCompactionError(error),
        recovery: "stale_thread_binding",
      });
    }
    embeddedAgentLog.warn("codex app-server compaction failed", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      threadId: binding.threadId,
      reason: formatCompactionError(error),
    });
    return {
      ok: false,
      compacted: false,
      reason: formatCompactionError(error),
    };
  }
  const resultDetails: JsonObject = {
    backend: "codex-app-server",
    threadId: binding.threadId,
    signal: "thread/compact/start",
    pending: true,
  };
  return {
    ok: true,
    compacted: false,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      details: resultDetails,
    },
  };
}

function failedCodexThreadBindingCompactionResult(
  params: CompactEmbeddedPiSessionParams,
  recovery: {
    binding?: CodexAppServerThreadBinding;
    reason: string;
    recovery: "missing_thread_binding" | "stale_thread_binding";
    threadId?: string;
  },
): EmbeddedPiCompactResult {
  const bindingDiagnosticFields = codexNativeBindingDiagnosticFields(recovery.binding);
  emitCodexNativeThreadCompactionDiagnostic(params, {
    action: recovery.recovery === "stale_thread_binding" ? "rejected" : "failed",
    reason:
      recovery.recovery === "missing_thread_binding"
        ? CodexNativeThreadLifecycleReason.MissingThreadBinding
        : CodexNativeThreadLifecycleReason.AppServerRejectedThread,
    level: "warn",
    message: "codex app-server compaction could not use thread binding",
    ...bindingDiagnosticFields,
    threadId: recovery.threadId ?? bindingDiagnosticFields.threadId,
    bindingMode: recovery.binding
      ? bindingDiagnosticFields.bindingMode
      : recovery.threadId
        ? "legacy"
        : "none",
    extra: {
      reason: recovery.reason,
      recovery: recovery.recovery,
    },
  });
  return {
    ok: false,
    compacted: false,
    reason: recovery.reason,
    failure: {
      reason: recovery.recovery,
      rawError: recovery.reason,
    },
  };
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  return formatCompactionError(error).toLowerCase().includes("thread not found");
}

function formatCompactionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
