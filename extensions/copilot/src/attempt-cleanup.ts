import {
  awaitAgentEndSideEffects,
  runAgentEndSideEffectsAsync,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { raceWithTimeout, withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { toCopilotError } from "./attempt-config.js";
import {
  BACKGROUND_COMPACTION_CANCEL_TIMEOUT_MS,
  type AgentHarnessAttemptResult,
  type AttemptParamsLike,
  type CopilotAgentEndHookParams,
} from "./attempt-types.js";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";
import type { CopilotClientPool, PooledClient } from "./runtime.js";

/** Deletion follows disconnect even when disconnect fails; the first cleanup failure wins. */
export async function disconnectCopilotSession(params: {
  session: SessionLike;
  client: PooledClient["client"];
  deleteSessionId?: string;
}): Promise<void> {
  let failure: Error | undefined;
  try {
    await params.session.disconnect();
  } catch (error) {
    failure = toCopilotError(error);
  }
  if (params.deleteSessionId) {
    try {
      await params.client.deleteSession(params.deleteSessionId);
    } catch (error) {
      failure ??= toCopilotError(error);
    }
  }
  if (failure) {
    throw failure;
  }
}

export function preserveCopilotAttemptCleanupError(
  primary: Error | undefined,
  error: unknown,
): Error {
  if (primary) {
    console.warn("[copilot-attempt] detached session cleanup failed after primary error", error);
    return primary;
  }
  return toCopilotError(error);
}

export async function finalizeCopilotAttempt(
  params: AttemptParamsLike,
  result: AgentHarnessAttemptResult,
  ctx: CopilotAgentEndHookParams["ctx"],
  attemptStartedAt: number,
  now: () => number,
): Promise<AgentHarnessAttemptResult> {
  const failure =
    result.terminal.kind === "failed"
      ? { error: result.terminal.error }
      : result.terminal.kind === "ok"
        ? undefined
        : result.terminal.failure;
  const aborted = result.terminal.kind === "aborted" && result.terminal.source !== "yield_cleanup";
  const timedOut = result.terminal.kind === "timeout" && result.terminal.source !== "observation";
  const hookParams = {
    event: {
      messages: result.messagesSnapshot,
      success: !aborted && !failure && !timedOut,
      ...(failure
        ? { error: toCopilotError(failure.error).message }
        : timedOut
          ? { error: "Copilot SDK turn timed out." }
          : {}),
      durationMs: now() - attemptStartedAt,
    },
    ctx,
  };
  if (!params.messageChannel && !params.messageProvider) {
    await awaitAgentEndSideEffects(hookParams);
  } else {
    await runAgentEndSideEffectsAsync(hookParams);
  }
  return result;
}
export async function deferBackgroundCompactionCleanup(params: {
  abortSignal: AbortSignal | undefined;
  awaitSessionIdle: boolean;
  bridge: ReturnType<typeof attachEventBridge>;
  handle: PooledClient;
  pool: CopilotClientPool;
  cleanupByokProxy?: () => Promise<void>;
  cleanupToolBridge?: () => void;
  deleteSessionOnIncompleteCleanup: boolean;
  deleteSessionOnCleanup?: boolean;
  sdkSessionId?: string;
  session: SessionLike;
  timeoutMs: number;
}): Promise<"aborted" | "completed" | "deadline"> {
  let outcome: "aborted" | "completed" | "deadline" = "deadline";
  let cleanupError: Error | undefined;
  try {
    outcome = await awaitDeferredCleanupBeforeDeadline({
      abortSignal: params.abortSignal,
      awaitSessionIdle: params.awaitSessionIdle,
      bridge: params.bridge,
      timeoutMs: params.timeoutMs,
    });
  } catch {
    // A failed wait follows the same bounded cancellation path as its deadline.
  } finally {
    if (outcome !== "completed") {
      await cancelBackgroundCompactionBeforeTeardown(params.session);
      params.bridge.settleCompactionWait();
    }
    params.bridge.detach();
    await params.bridge.awaitAgentEventChain();
    params.cleanupToolBridge?.();
    try {
      await params.cleanupByokProxy?.();
    } catch (error) {
      cleanupError ??= toCopilotError(error);
    }
    try {
      await disconnectCopilotSession({
        session: params.session,
        client: params.handle.client,
        deleteSessionId:
          params.deleteSessionOnCleanup ||
          (outcome !== "completed" && params.deleteSessionOnIncompleteCleanup)
            ? params.sdkSessionId
            : undefined,
      });
    } catch (error) {
      // Disposable owners await this cleanup; ordinary checkpoints retain best effort.
      if (params.deleteSessionOnCleanup) {
        cleanupError ??= toCopilotError(error);
      }
    }
    try {
      await params.pool.release(params.handle);
    } catch (error) {
      // Ordinary deferred teardown cannot replace an already-returned turn outcome.
      if (params.deleteSessionOnCleanup) {
        cleanupError ??= toCopilotError(error);
      }
    }
  }
  if (cleanupError) {
    throw cleanupError;
  }
  return outcome;
}
async function cancelBackgroundCompactionBeforeTeardown(session: SessionLike): Promise<void> {
  const cancelBackgroundCompaction = session.rpc?.history?.cancelBackgroundCompaction;
  if (!cancelBackgroundCompaction) {
    return;
  }
  await withTimeout(
    Promise.resolve().then(() => cancelBackgroundCompaction()),
    BACKGROUND_COMPACTION_CANCEL_TIMEOUT_MS,
  ).catch(() => undefined);
}
async function awaitDeferredCleanupBeforeDeadline(params: {
  abortSignal: AbortSignal | undefined;
  awaitSessionIdle: boolean;
  bridge: ReturnType<typeof attachEventBridge>;
  timeoutMs: number;
}): Promise<"aborted" | "completed" | "deadline"> {
  if (params.abortSignal?.aborted) {
    return "aborted";
  }
  const completion = (async () => {
    if (params.awaitSessionIdle) {
      await params.bridge.awaitSessionIdle();
    }
    await params.bridge.awaitCompactionCompletion();
    return "completed" as const;
  })();
  return await raceWithTimeout(completion, params.timeoutMs, () => "deadline" as const, {
    signal: params.abortSignal,
    onAbort: () => "aborted" as const,
  });
}
