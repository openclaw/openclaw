import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { refreshMemoryProviderWithHandoff } from "../../plugins/memory-provider-adapter.js";
import type { MemoryAudience } from "../../plugins/memory-provider-types.js";
import {
  getActiveMemoryProviderCore,
  getActiveMemorySearchManagerCore,
} from "../../plugins/memory-runtime.js";
import { resolveLoadedMemoryProviderKind } from "../../plugins/memory-state.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchIndexConfig } from "../memory-search.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  estimateCompactedRequestTokens,
  type CompactionRequestBudget,
} from "../sessions/compaction/request-budget.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { log } from "./logger.js";

type PostCompactionSession = {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  memoryAudience?: MemoryAudience;
  sandboxed?: boolean;
  sessionFile: string;
  assertActive?: () => void | Promise<void>;
};

async function runPostCompactionSessionMemorySync(
  params: PostCompactionSession & { config: OpenClawConfig },
  onStarted: () => void,
): Promise<void> {
  try {
    const agentId = resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // A native slot owner owns its refresh. Classification reads owners this process
    // already loaded; every other owner keeps the session-sync checks below, which
    // never load the slot plugin or call it just to decide.
    if (resolveLoadedMemoryProviderKind(params.config) === "native") {
      const sessionKey = params.sessionKey?.trim();
      const authority =
        params.memoryAudience && sessionKey
          ? {
              kind: "session" as const,
              sessionKey,
              sessionId: params.sessionId?.trim() || undefined,
              sandboxed: params.sandboxed === true,
              audience: params.memoryAudience,
            }
          : { kind: "host" as const, operation: "post-compaction-refresh" };
      let provider: Awaited<ReturnType<typeof getActiveMemoryProviderCore>>["provider"] = null;
      try {
        await params.assertActive?.();
        // Providers check currency synchronously before I/O; the memory runtime adds audience
        // currency to this guard. The caller's writer check can await a session read, so it
        // runs at the awaited gates around open and refresh instead.
        const acquired = await getActiveMemoryProviderCore({
          cfg: params.config,
          agentId,
          context: { authority, assertCurrent: () => {} },
        });
        provider = acquired.provider;
        await params.assertActive?.();
        if (!provider) {
          log.debug(
            `memory refresh denied (post-compaction) for ${acquired.providerId ?? "selected memory provider"}: ${acquired.error ?? "provider unavailable"}`,
          );
          return;
        }
        if (!provider.refresh) {
          log.debug(
            `memory refresh unsupported (post-compaction) for ${acquired.providerId ?? "selected memory provider"}`,
          );
          return;
        }
        await refreshMemoryProviderWithHandoff(provider, onStarted);
        await params.assertActive?.();
      } catch (error) {
        log.debug(`memory refresh failed (post-compaction): ${formatErrorMessage(error)}`);
      } finally {
        await provider?.close().catch(() => {});
      }
      return;
    }
    // The memory backend owns provider resolution; an unavailable backend must
    // not cold-load embedding plugins just to decide whether to sync.
    const resolvedMemory = resolveMemorySearchIndexConfig(params.config, agentId);
    if (!resolvedMemory || !resolvedMemory.sources.includes("sessions")) {
      return;
    }
    if (!resolvedMemory.sync.sessions.postCompactionForce) {
      return;
    }
    await params.assertActive?.();
    const { manager } = await getActiveMemorySearchManagerCore({
      cfg: params.config,
      agentId,
    });
    await params.assertActive?.();
    if (!manager?.sync) {
      return;
    }
    const sessionId = params.sessionId?.trim();
    const sync = manager.sync({
      reason: "post-compaction",
      ...(sessionId
        ? {
            sessions: [
              {
                agentId,
                sessionId,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
              },
            ],
          }
        : { archiveFiles: [params.sessionFile] }),
    });
    onStarted();
    await sync;
  } catch (err) {
    await params.assertActive?.();
    log.warn(`memory sync skipped (post-compaction): ${formatErrorMessage(err)}`);
  }
}

export async function runPostCompactionSideEffects(params: PostCompactionSession): Promise<void> {
  await params.assertActive?.();
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return;
  }
  emitSessionTranscriptUpdate({
    sessionFile,
    sessionKey: params.sessionKey,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  await params.assertActive?.();
  const mode = params.config?.agents?.defaults?.compaction?.postIndexSync ?? "async";
  const started = createDeferredCore();
  const syncTask =
    mode !== "off" && params.config
      ? runPostCompactionSessionMemorySync(
          { ...params, config: params.config, sessionFile },
          started.resolve,
        )
      : undefined;
  if (mode !== "await") {
    // Async indexing cannot leak an abort rejection after foreground settlement.
    void syncTask?.catch((error: unknown) => {
      log.debug(`memory sync cancelled (post-compaction): ${formatErrorMessage(error)}`);
    });
  }
  // Manager/provider acquisition still needs the caller's authority. Once invoked,
  // the memory owner retains accepted indexing through foreground and Gateway close.
  if (syncTask) {
    void syncTask.then(
      () => started.resolve(),
      () => started.resolve(),
    );
    await (mode === "await" ? syncTask : started.promise);
  }
  await params.assertActive?.();
}

type CompactionHookRunner = Partial<
  Pick<HookRunner, "hasHooks" | "runBeforeCompaction" | "runAfterCompaction">
>;

function estimateTokenCountSafe(
  messages: AgentMessage[],
  estimateTokensFn: (message: AgentMessage) => number,
): number | undefined {
  try {
    let total = 0;
    for (const message of messages) {
      total += estimateTokensFn(message);
    }
    return total;
  } catch {
    return undefined;
  }
}

/** Builds before-hook metrics while tolerating providers that cannot estimate all messages. */
export function buildBeforeCompactionHookMetrics(params: {
  originalMessages: AgentMessage[];
  currentMessages: AgentMessage[];
  observedTokenCount?: number;
  estimateTokensFn: (message: AgentMessage) => number;
}) {
  return {
    messageCountOriginal: params.originalMessages.length,
    tokenCountOriginal: estimateTokenCountSafe(params.originalMessages, params.estimateTokensFn),
    messageCountBefore: params.currentMessages.length,
    tokenCountBefore:
      params.observedTokenCount ??
      estimateTokenCountSafe(params.currentMessages, params.estimateTokensFn),
  };
}

/** Estimates compacted-session token count and rejects impossible growth from stale estimates. */
export function estimateTokensAfterCompaction(params: {
  messagesAfter: AgentMessage[];
  observedTokenCount?: number;
  fullSessionTokensBefore: number;
  estimateTokensFn: (message: AgentMessage) => number;
  requestBudget?: CompactionRequestBudget;
}) {
  if (params.requestBudget) {
    return estimateCompactedRequestTokens(params.messagesAfter, {
      ...params.requestBudget,
      pendingTokens: 0,
    });
  }
  const tokensAfter = estimateTokenCountSafe(params.messagesAfter, params.estimateTokensFn);
  if (tokensAfter === undefined) {
    return undefined;
  }
  const sanityCheckBaseline = params.observedTokenCount ?? params.fullSessionTokensBefore;
  return sanityCheckBaseline > 0 &&
    tokensAfter >
      (params.observedTokenCount !== undefined ? sanityCheckBaseline : sanityCheckBaseline * 1.1)
    ? undefined
    : tokensAfter;
}

type CompactionHookParams = {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionKey: string;
  sessionAgentId: string;
  workspaceDir: string;
  messageProvider?: string;
  assertActive?: () => void;
  onHookMessages?: CompactEmbeddedAgentSessionParams["onCompactionHookMessages"];
} & (
  | { phase: "before"; metrics: ReturnType<typeof buildBeforeCompactionHookMetrics> }
  | {
      phase: "after";
      messageCountAfter: number;
      tokensAfter?: number;
      compactedCount: number;
      sessionFile: string;
      previousSessionId?: string;
      summaryLength?: number;
      tokensBefore?: number;
      firstKeptEntryId?: string;
    }
);

/** Internal hooks settle and forward messages before plugin hooks see the same phase. */
export async function runCompactionHooks(params: CompactionHookParams): Promise<void> {
  params.assertActive?.();
  const logHookFailure = (hookName: string, error: unknown) => {
    params.assertActive?.();
    log.warn(`${hookName} hook failed`, {
      errorMessage: formatErrorMessage(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
  };
  try {
    const hookEvent = createInternalHookEvent(
      "session",
      `compact:${params.phase}`,
      params.sessionKey,
      {
        sessionId: params.sessionId,
        missingSessionKey: false,
        ...(params.phase === "before"
          ? {
              messageCount: params.metrics.messageCountBefore,
              tokenCount: params.metrics.tokenCountBefore,
              messageCountOriginal: params.metrics.messageCountOriginal,
              tokenCountOriginal: params.metrics.tokenCountOriginal,
            }
          : {
              messageCount: params.messageCountAfter,
              tokenCount: params.tokensAfter,
              compactedCount: params.compactedCount,
              summaryLength: params.summaryLength,
              tokensBefore: params.tokensBefore,
              tokensAfter: params.tokensAfter,
              firstKeptEntryId: params.firstKeptEntryId,
            }),
      },
    );
    await triggerInternalHook(hookEvent);
    params.assertActive?.();
    if (hookEvent.messages.length > 0) {
      await params.onHookMessages?.({
        phase: params.phase,
        messages: hookEvent.messages.slice(),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
    }
  } catch (err) {
    logHookFailure(`session:compact:${params.phase}`, err);
  }
  params.assertActive?.();
  if (params.hookRunner?.hasHooks?.(`${params.phase}_compaction`)) {
    try {
      const context = {
        sessionId: params.sessionId,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        messageProvider: params.messageProvider,
      };
      if (params.phase === "before") {
        await params.hookRunner.runBeforeCompaction?.(
          {
            messageCount: params.metrics.messageCountBefore,
            tokenCount: params.metrics.tokenCountBefore,
          },
          context,
        );
      } else {
        await params.hookRunner.runAfterCompaction?.(
          {
            messageCount: params.messageCountAfter,
            tokenCount: params.tokensAfter,
            compactedCount: params.compactedCount,
            sessionFile: params.sessionFile,
            ...(params.previousSessionId ? { previousSessionId: params.previousSessionId } : {}),
          },
          context,
        );
      }
    } catch (err) {
      logHookFailure(`${params.phase}_compaction`, err);
    }
  }
  params.assertActive?.();
}
