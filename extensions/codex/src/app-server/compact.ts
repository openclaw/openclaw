/**
 * Native Codex app-server compaction bridge for bound OpenClaw sessions.
 */
import {
  embeddedAgentLog,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  isCodexAppServerUnsafeSubscriptionError,
  settleCodexAppServerClientLease,
} from "./attempt-client-cleanup.js";
import { readCodexNotificationItem } from "./attempt-notifications.js";
import { resolveCodexTurnTerminalIdleTimeoutMs } from "./attempt-timeouts.js";
import { CodexAppServerRpcError } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import {
  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import {
  leaseSharedCodexAppServerClient,
  type CodexAppServerClientLease,
  type CodexAppServerClientLeaseFactory,
  type CodexAppServerClientOptions,
} from "./shared-client.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";
import { withTimeout } from "./timeout.js";
import {
  getCodexAppServerTurnRouter,
  isCodexTerminalTurnNotification,
  type CodexNativeTurnCompletionWatch,
  type CodexThreadRouteReservation,
} from "./turn-router.js";

type CodexAppServerCompactOptions = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  clientLeaseFactory?: CodexAppServerClientLeaseFactory;
  allowNonManualNativeRequest?: boolean;
};

class CodexNativeTurnBindingChangedError extends Error {}

type CodexNativeTurnRequest = {
  bindingStore: CodexAppServerBindingStore;
  bindingIdentity: CodexAppServerBindingIdentity;
  expectedBinding: CodexAppServerThreadBinding;
  pluginConfig?: unknown;
  authProfileId?: string;
  agentDir?: string;
  config?: CodexAppServerClientOptions["config"];
  abortSignal?: AbortSignal;
  clientLeaseFactory?: CodexAppServerClientLeaseFactory;
};

export type CodexNativeTurnKind = "compact" | "review";

/** Starts one native Codex turn and retains its app-server owner through completion. */
export async function requestCodexNativeTurnForBinding(
  params: CodexNativeTurnRequest,
  kind: CodexNativeTurnKind,
): Promise<void> {
  const isCompaction = kind === "compact";
  const label = isCompaction ? "compaction" : "review";
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const requestTimeoutMs = Math.min(
    appServer.requestTimeoutMs,
    CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
  );
  await params.bindingStore.withLease(params.bindingIdentity, async () => {
    const currentBinding = await params.bindingStore.read(params.bindingIdentity);
    if (!currentBinding || !isSameNativeTurnBinding(currentBinding, params.expectedBinding)) {
      throw new CodexNativeTurnBindingChangedError(
        `Codex thread binding changed before native ${label}`,
      );
    }
    const clientLease = await (params.clientLeaseFactory ?? leaseSharedCodexAppServerClient)({
      startOptions: appServer.start,
      authProfileId: params.authProfileId ?? currentBinding.authProfileId,
      agentDir: params.agentDir,
      config: params.config,
      abandonSignal: params.abortSignal,
      timeoutMs: appServer.requestTimeoutMs,
    });
    const client = clientLease.client;
    let subscribedThreadId: string | undefined;
    let abandonClient = false;
    let lifecycleTransferred = false;
    let awaitingNativeTurnStart = false;
    const terminalTurnsBeforeWatch = new Set<string>();
    let route: CodexThreadRouteReservation | undefined;
    let completionWatch: CodexNativeTurnCompletionWatch | undefined;
    let observedContextCompaction = false;
    let bindingInvalidated = false;
    let resolveNativeTurnStarted!: () => void;
    const nativeTurnStarted = new Promise<void>((resolve) => {
      resolveNativeTurnStarted = resolve;
    });
    try {
      const router = getCodexAppServerTurnRouter(client);
      route = router.reserveThread({
        threadId: currentBinding.threadId,
        onNotificationReceived: (notification, scope) => {
          const contextCompactionStarted =
            isCompaction &&
            Boolean(scope.turnId) &&
            notification.method === "item/started" &&
            readCodexNotificationItem(notification.params)?.type === "contextCompaction";
          if (contextCompactionStarted) {
            observedContextCompaction = true;
          }
          if (!awaitingNativeTurnStart || !scope.turnId) {
            return;
          }
          if (isCodexTerminalTurnNotification(notification)) {
            terminalTurnsBeforeWatch.add(scope.turnId);
          }
          if (contextCompactionStarted) {
            completionWatch ??= router.watchNativeTurnCompletion({
              threadId: currentBinding.threadId,
              turnId: scope.turnId,
              timeoutMs: resolveCodexTurnTerminalIdleTimeoutMs(undefined),
            });
            resolveNativeTurnStarted();
          }
        },
        onNotification: () => undefined,
      });
      throwIfCodexNativeTurnAborted(params.abortSignal, kind);
      let resumed;
      try {
        subscribedThreadId = currentBinding.threadId;
        resumed = await resumeCodexAppServerThread({
          client,
          abandonClient: clientLease.abandon,
          request: {
            threadId: currentBinding.threadId,
            excludeTurns: true,
            persistExtendedHistory: true,
          },
          timeoutMs: requestTimeoutMs,
          signal: params.abortSignal,
        });
      } catch (error) {
        abandonClient = isCodexAppServerUnsafeSubscriptionError(error);
        throw error;
      }
      const invalidateNativeContextBinding = async () => {
        if (bindingInvalidated) {
          return;
        }
        const invalidated = await params.bindingStore.mutate(params.bindingIdentity, {
          kind: "invalidate-native-context",
          threadId: currentBinding.threadId,
          ...(isCompaction ? { invalidateContextEngineProjection: true as const } : {}),
        });
        if (!invalidated) {
          throw new CodexNativeTurnBindingChangedError(
            `Codex thread binding changed before native ${label}`,
          );
        }
        bindingInvalidated = true;
      };
      if (isCompaction && observedContextCompaction) {
        await invalidateNativeContextBinding();
      }
      if (resumed.thread.status?.type === "active") {
        throw new Error(
          `Codex thread already has an active turn; retry ${label} after it finishes`,
        );
      }
      throwIfCodexNativeTurnAborted(params.abortSignal, kind);
      await invalidateNativeContextBinding();
      awaitingNativeTurnStart = true;
      let requestResult: JsonValue | undefined;
      try {
        requestResult = await client.request(
          isCompaction ? "thread/compact/start" : "review/start",
          isCompaction
            ? { threadId: currentBinding.threadId }
            : { threadId: currentBinding.threadId, target: { type: "uncommittedChanges" } },
          { timeoutMs: requestTimeoutMs },
        );
      } catch (error) {
        const requestRejected = error instanceof CodexAppServerRpcError;
        if (requestRejected) {
          // A structured rejection proves this request did not start a native
          // turn. Preserve only compaction already observed on the same thread.
          completionWatch?.cancel();
          completionWatch = undefined;
          if (!isCompaction || !observedContextCompaction) {
            const restored = await params.bindingStore.mutate(params.bindingIdentity, {
              kind: "set",
              binding: currentBinding,
            });
            if (!restored) {
              throw new Error(`Codex thread binding changed after native ${label} was rejected`, {
                cause: error,
              });
            }
          }
          throw error;
        }
        if (completionWatch) {
          embeddedAgentLog.debug(`codex app-server ${kind} request failed after startup`, {
            threadId: currentBinding.threadId,
            error,
          });
        } else {
          abandonClient = true;
          throw error;
        }
      }
      if (!isCompaction) {
        try {
          const review = assertCodexReviewStartResponse(requestResult);
          if (review.reviewThreadId !== currentBinding.threadId) {
            throw new Error(
              `Codex review/start returned ${review.reviewThreadId} for inline review on ${currentBinding.threadId}`,
            );
          }
          completionWatch = terminalTurnsBeforeWatch.has(review.turnId)
            ? { completion: Promise.resolve(true), cancel: () => undefined }
            : router.watchNativeTurnCompletion({
                threadId: currentBinding.threadId,
                turnId: review.turnId,
                timeoutMs: resolveCodexTurnTerminalIdleTimeoutMs(undefined),
              });
        } catch (error) {
          abandonClient = true;
          throw error;
        }
      } else if (!completionWatch) {
        try {
          await waitForCodexNativeTurnStart({
            started: nativeTurnStarted,
            routeSignal: route.signal,
            timeoutMs: requestTimeoutMs,
            threadId: currentBinding.threadId,
            kind,
          });
        } catch (error) {
          // Codex accepted Op::Compact, so missing startup confirmation is
          // ambiguous. Keep facts invalidated and retire this connection.
          abandonClient = true;
          throw error;
        }
      }
      awaitingNativeTurnStart = false;
      route.release();
      route = undefined;
      const transferredWatch = completionWatch;
      if (!transferredWatch) {
        abandonClient = true;
        throw new Error(
          `codex app-server ${kind} turn started without a turn id for thread ${currentBinding.threadId}`,
        );
      }
      completionWatch = undefined;
      lifecycleTransferred = true;
      monitorCodexNativeTurn({
        completionWatch: transferredWatch,
        clientLease,
        subscribedThreadId,
        threadId: currentBinding.threadId,
        kind,
      });
    } finally {
      if (!lifecycleTransferred) {
        completionWatch?.cancel();
        route?.release();
        await settleCodexAppServerClientLease(clientLease, {
          threadId: subscribedThreadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
          abandon: abandonClient,
        });
      }
    }
  });
}

function assertCodexReviewStartResponse(value: JsonValue | undefined): {
  turnId: string;
  reviewThreadId: string;
} {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.turn) ||
    typeof value.turn.id !== "string" ||
    !value.turn.id.trim() ||
    typeof value.reviewThreadId !== "string" ||
    !value.reviewThreadId.trim()
  ) {
    throw new Error("invalid Codex review/start response");
  }
  return { turnId: value.turn.id, reviewThreadId: value.reviewThreadId };
}

function monitorCodexNativeTurn(params: {
  completionWatch: CodexNativeTurnCompletionWatch;
  clientLease: CodexAppServerClientLease;
  subscribedThreadId?: string;
  threadId: string;
  kind: CodexNativeTurnKind;
}): void {
  void (async () => {
    const completed = await params.completionWatch.completion;
    await settleCodexAppServerClientLease(params.clientLease, {
      threadId: params.subscribedThreadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      abandon: !completed,
    });
    if (!completed) {
      embeddedAgentLog.warn(`codex app-server ${params.kind} turn lost terminal confirmation`, {
        threadId: params.threadId,
      });
    }
  })().catch(async (error: unknown) => {
    await params.clientLease.abandon().catch(() => undefined);
    embeddedAgentLog.warn(`codex app-server ${params.kind} turn cleanup failed`, {
      threadId: params.threadId,
      error,
    });
  });
}

function throwIfCodexNativeTurnAborted(
  signal: AbortSignal | undefined,
  kind: CodexNativeTurnKind,
): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error(`codex app-server ${kind} aborted before native turn startup`, {
    cause: signal.reason,
  });
}

async function waitForCodexNativeTurnStart(params: {
  started: Promise<void>;
  routeSignal: AbortSignal;
  timeoutMs: number;
  threadId: string;
  kind: CodexNativeTurnKind;
}): Promise<void> {
  const signal = params.routeSignal;
  let removeAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(asNativeTurnAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    await withTimeout(
      Promise.race([params.started, aborted]),
      params.timeoutMs,
      `codex app-server ${params.kind} turn did not start for thread ${params.threadId}`,
    );
  } finally {
    removeAbort?.();
  }
}

function asNativeTurnAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("codex app-server native turn startup aborted", { cause: signal.reason });
}

/**
 * Starts native Codex compaction for a manually requested bound session, or
 * reports why Codex-owned automatic compaction should handle the trigger.
 */
export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedAgentSessionParams,
  options: CodexAppServerCompactOptions,
): Promise<EmbeddedAgentCompactResult | undefined> {
  // Codex owns automatic context-pressure compaction for Codex runtime sessions.
  // This entry point starts native Codex compaction for the bound thread and
  // returns immediately; Codex applies the compaction inside its app-server.
  return compactCodexNativeThread(params, options);
}

async function compactCodexNativeThread(
  params: CompactEmbeddedAgentSessionParams,
  options: CodexAppServerCompactOptions,
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
    agentId: params.agentId,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
    surface: "native compaction",
  });
  if (nativeExecutionBlock) {
    return { ok: false, compacted: false, reason: nativeExecutionBlock };
  }
  const bindingIdentity: CodexAppServerBindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const initialBinding = await options.bindingStore.read(bindingIdentity);
  if (!initialBinding?.threadId) {
    return failedCodexThreadBindingCompactionResult(params, {
      reason: "no codex app-server thread binding",
      recovery: "missing_thread_binding",
    });
  }
  const binding = initialBinding;
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
  if (options.allowNonManualNativeRequest && params.abortSignal?.aborted) {
    const currentBinding = await options.bindingStore.read(bindingIdentity);
    return skippedCodexNativeCompactionResult(params, {
      reason: "codex app-server compaction aborted before native compaction",
      code: "aborted_before_native_compaction",
      expectedThreadId: binding.threadId,
      currentThreadId: currentBinding?.threadId,
    });
  }
  try {
    await requestCodexNativeTurnForBinding(
      {
        bindingIdentity,
        bindingStore: options.bindingStore,
        expectedBinding: binding,
        pluginConfig: options.pluginConfig,
        authProfileId: requestedAuthProfileId,
        agentDir: params.agentDir,
        config: params.config,
        abortSignal: params.abortSignal,
        clientLeaseFactory: options.clientLeaseFactory,
      },
      "compact",
    );
    embeddedAgentLog.info("started codex app-server compaction", {
      sessionId: params.sessionId,
      threadId: binding.threadId,
    });
  } catch (error) {
    if (
      options.allowNonManualNativeRequest &&
      error instanceof CodexNativeTurnBindingChangedError
    ) {
      const latestBinding = await options.bindingStore.read(bindingIdentity);
      return skippedBindingChangeResult(params, binding.threadId, latestBinding?.threadId);
    }
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

function skippedBindingChangeResult(
  params: CompactEmbeddedAgentSessionParams,
  expectedThreadId: string,
  currentThreadId: string | undefined,
): EmbeddedAgentCompactResult {
  embeddedAgentLog.warn("skipping codex app-server compaction because the thread binding changed", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    expectedThreadId,
    currentThreadId,
  });
  return skippedCodexNativeCompactionResult(params, {
    reason: "codex app-server binding changed before native compaction",
    code: "binding_changed_before_native_compaction",
    expectedThreadId,
    currentThreadId,
  });
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

function isSameNativeTurnBinding(
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
