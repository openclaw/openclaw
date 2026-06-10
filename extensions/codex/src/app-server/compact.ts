/**
 * Native Codex app-server compaction bridge for bound OpenClaw sessions.
 */
import {
  embeddedAgentLog,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  defaultLeasedCodexAppServerClientFactory,
  type CodexAppServerClientFactory,
} from "./client-factory.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { JsonObject } from "./protocol.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import {
  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
  readCodexAppServerBinding,
  withCodexAppServerBindingLock,
  writeCodexAppServerBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { releaseLeasedSharedCodexAppServerClient } from "./shared-client.js";

const warnedIgnoredCompactionOverrides = new Set<string>();
type CodexAppServerCompactOptions = {
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
  allowNonManualNativeRequest?: boolean;
};

/**
 * Starts native Codex compaction for a manually requested bound session, or
 * reports why Codex-owned automatic compaction should handle the trigger.
 */
export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedAgentSessionParams,
  options: CodexAppServerCompactOptions = {},
): Promise<EmbeddedAgentCompactResult | undefined> {
  warnIfIgnoringOpenClawCompactionOverrides(params);
  // Codex owns automatic context-pressure compaction for Codex runtime sessions.
  // This entry point starts native Codex compaction for the bound thread and
  // returns immediately; Codex applies the compaction inside its app-server.
  return compactCodexNativeThread(params, options);
}

function warnIfIgnoringOpenClawCompactionOverrides(
  params: CompactEmbeddedAgentSessionParams,
): void {
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

function readIgnoredCompactionOverridePaths(params: CompactEmbeddedAgentSessionParams): string[] {
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

function readCompactionOverrideEntries(params: CompactEmbeddedAgentSessionParams): Array<{
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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function compactCodexNativeThread(
  params: CompactEmbeddedAgentSessionParams,
  options: CodexAppServerCompactOptions = {},
): Promise<EmbeddedAgentCompactResult | undefined> {
  if (params.trigger !== "manual" && !options.allowNonManualNativeRequest) {
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
  const initialBinding = await readCodexAppServerBinding(params.sessionFile, {
    config: params.config,
  });
  if (!initialBinding?.threadId) {
    return failedCodexThreadBindingCompactionResult(params, {
      reason: "no codex app-server thread binding",
      recovery: "missing_thread_binding",
    });
  }
  let binding = initialBinding;
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  if (
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    // A session binding belongs to the auth profile that created it; compacting
    // with another profile risks operating on a different Codex account.
    return { ok: false, compacted: false, reason: "auth profile mismatch for session binding" };
  }
  const shouldReleaseDefaultLease = !options.clientFactory;
  const clientFactory = options.clientFactory ?? defaultLeasedCodexAppServerClientFactory;
  const client = await clientFactory(
    appServer.start,
    requestedAuthProfileId ?? binding.authProfileId,
    params.agentDir,
    params.config,
  );
  try {
    if (options.allowNonManualNativeRequest) {
      const guardedResult = await withCodexAppServerBindingLock(params.sessionFile, async () => {
        const currentBinding = await readCodexAppServerBinding(params.sessionFile, {
          config: params.config,
        });
        if (params.abortSignal?.aborted) {
          return {
            started: false as const,
            result: skippedCodexNativeCompactionResult(params, {
              reason: "codex app-server compaction aborted before native compaction",
              code: "aborted_before_native_compaction",
              expectedThreadId: binding.threadId,
              currentThreadId: currentBinding?.threadId,
            }),
          };
        }
        if (!currentBinding || !isSameNativeCompactionBinding(currentBinding, binding)) {
          embeddedAgentLog.warn(
            "skipping codex app-server compaction because the thread binding changed",
            {
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              expectedThreadId: binding.threadId,
              currentThreadId: currentBinding?.threadId,
            },
          );
          return {
            started: false as const,
            result: skippedCodexNativeCompactionResult(params, {
              reason: "codex app-server binding changed before native compaction",
              code: "binding_changed_before_native_compaction",
              expectedThreadId: binding.threadId,
              currentThreadId: currentBinding?.threadId,
            }),
          };
        }
        binding = currentBinding;
        await clearContextEngineProjectionBeforeNativeCompaction({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          binding,
          config: params.config,
        });
        await client.request(
          "thread/compact/start",
          {
            threadId: binding.threadId,
          },
          {
            timeoutMs: Math.min(
              appServer.requestTimeoutMs,
              CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
            ),
          },
        );
        return { started: true as const };
      });
      if (!guardedResult.started) {
        return guardedResult.result;
      }
    } else {
      await client.request("thread/compact/start", {
        threadId: binding.threadId,
      });
    }
    embeddedAgentLog.info("started codex app-server compaction", {
      sessionId: params.sessionId,
      threadId: binding.threadId,
    });
  } catch (error) {
    if (isCodexThreadNotFoundError(error)) {
      return failedCodexThreadBindingCompactionResult(params, {
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
  } finally {
    if (shouldReleaseDefaultLease) {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
  const resultDetails: JsonObject = {
    backend: "codex-app-server",
    threadId: binding.threadId,
    signal: "thread/compact/start",
    pending: true,
    ...(options.allowNonManualNativeRequest
      ? {
          request: "after_context_engine",
          trigger: params.trigger ?? "unknown",
        }
      : {}),
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

function skippedCodexNativeCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  skipped: {
    reason: string;
    code: string;
    expectedThreadId?: string;
    currentThreadId?: string;
  },
): EmbeddedAgentCompactResult {
  return {
    ok: true,
    compacted: false,
    reason: skipped.reason,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      details: {
        backend: "codex-app-server",
        skipped: true,
        reason: skipped.code,
        request: "after_context_engine",
        trigger: params.trigger ?? "unknown",
        ...(skipped.expectedThreadId ? { expectedThreadId: skipped.expectedThreadId } : {}),
        ...(skipped.currentThreadId ? { currentThreadId: skipped.currentThreadId } : {}),
      },
    },
  };
}

function failedCodexThreadBindingCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  recovery: {
    reason: string;
    recovery: "missing_thread_binding" | "stale_thread_binding";
    threadId?: string;
  },
): EmbeddedAgentCompactResult {
  embeddedAgentLog.warn("codex app-server compaction could not use thread binding", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    threadId: recovery.threadId,
    reason: recovery.reason,
    recovery: recovery.recovery,
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

async function clearContextEngineProjectionBeforeNativeCompaction(params: {
  sessionId: string;
  sessionFile: string;
  binding: CodexAppServerThreadBinding;
  config: CompactEmbeddedAgentSessionParams["config"];
}): Promise<void> {
  const contextEngineBinding = params.binding.contextEngine;
  if (!contextEngineBinding?.projection) {
    return;
  }
  // Native Codex compaction mutates the thread history outside the projection
  // guard. Clear only the projection marker so the next turn reprojects context.
  await writeCodexAppServerBinding(
    params.sessionFile,
    {
      ...params.binding,
      contextEngine: {
        ...contextEngineBinding,
        projection: undefined,
      },
      createdAt: params.binding.createdAt,
    },
    { config: params.config },
  );
  embeddedAgentLog.info("cleared codex context-engine projection before native compaction", {
    sessionId: params.sessionId,
    threadId: params.binding.threadId,
    previousEpoch: contextEngineBinding.projection.epoch,
    previousFingerprint: contextEngineBinding.projection.fingerprint,
  });
}

function isSameNativeCompactionBinding(
  current: CodexAppServerThreadBinding,
  expected: CodexAppServerThreadBinding,
): boolean {
  return (
    current.threadId === expected.threadId &&
    current.authProfileId === expected.authProfileId &&
    current.contextEngine?.engineId === expected.contextEngine?.engineId &&
    current.contextEngine?.policyFingerprint === expected.contextEngine?.policyFingerprint &&
    current.contextEngine?.projection?.mode === expected.contextEngine?.projection?.mode &&
    current.contextEngine?.projection?.epoch === expected.contextEngine?.projection?.epoch &&
    current.contextEngine?.projection?.fingerprint ===
      expected.contextEngine?.projection?.fingerprint
  );
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
