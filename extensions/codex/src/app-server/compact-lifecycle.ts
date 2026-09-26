import { AsyncLocalStorage } from "node:async_hooks";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isCodexNoActiveTurnInterruptError } from "./attempt-client-cleanup.js";
import { readCodexNotificationItem } from "./attempt-notifications.js";
import type { CodexAppServerClient } from "./client.js";
import { readCodexThreadContextSnapshot } from "./event-projector-usage.js";
import {
  readCodexNotificationThreadId,
  readCodexNotificationTurnId,
} from "./notification-correlation.js";
import { isJsonObject } from "./protocol.js";

type CodexNativeCompactionCompletion =
  | { completed: true; turnId?: string; itemId?: string; tokensAfter?: number }
  | { completed: false; reason: string };

export function watchCodexNativeCompactionCompletion(params: {
  client: CodexAppServerClient;
  threadId: string;
  signal?: AbortSignal;
  timeoutMs: number;
  interruptGraceMs: number;
  retireUnconfirmed: () => Promise<void>;
  onCompactionTurn?: (turnId: string) => void;
}) {
  const runOutsideBindingLease = AsyncLocalStorage.snapshot();
  let settled = false;
  let requestStarted = false;
  let abortRequested = false;
  let interruptRequested = false;
  let retirementStarted = false;
  let compactionTurnId: string | undefined;
  let compactionItemId: string | undefined;
  let compactionItemCompleted = false;
  let tokensAfter: number | undefined;
  let admissionFailure: string | undefined;
  const { promise: completion, resolve: resolveCompletion } =
    createDeferred<CodexNativeCompactionCompletion>();
  let removeNotificationHandler = () => {};
  let removeCloseHandler = () => {};
  let removeAbortHandler = () => {};
  let completionTimeout: ReturnType<typeof setTimeout> | undefined;
  let interruptGraceTimeout: ReturnType<typeof setTimeout> | undefined;
  const finish = (result: CodexNativeCompactionCompletion) => {
    if (settled) {
      return;
    }
    settled = true;
    removeNotificationHandler();
    removeCloseHandler();
    removeAbortHandler();
    clearTimeout(completionTimeout);
    clearTimeout(interruptGraceTimeout);
    resolveCompletion(result);
  };
  const complete = () =>
    finish({
      completed: true,
      ...(compactionTurnId ? { turnId: compactionTurnId } : {}),
      ...(compactionItemId ? { itemId: compactionItemId } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    });
  const fail = (reason: string) => finish({ completed: false, reason });
  const retireUnconfirmed = (reason: string) => {
    if (settled || retirementStarted) {
      return;
    }
    retirementStarted = true;
    // Timers started under the short-lived binding lease inherit its async
    // owner. Remote retirement must not reuse that already-released token.
    void runOutsideBindingLease(() => params.retireUnconfirmed())
      .then(() => fail(reason))
      .catch((error: unknown) => {
        embeddedAgentLog.error("failed to retire unconfirmed codex app-server compaction", {
          threadId: params.threadId,
          turnId: compactionTurnId,
          reason: coerceErrorMessage(error),
        });
        // Keep the lifecycle fence held when neither terminal state nor thread
        // retirement can be proven. Releasing would permit same-thread overlap.
      });
  };
  const requestInterrupt = () => {
    if (settled || !requestStarted || !abortRequested || !compactionTurnId || interruptRequested) {
      return;
    }
    interruptRequested = true;
    void params.client
      .request(
        "turn/interrupt",
        {
          threadId: params.threadId,
          turnId: compactionTurnId,
        },
        { timeoutMs: Math.max(1, params.interruptGraceMs) },
      )
      .catch((error: unknown) => {
        if (isCodexNoActiveTurnInterruptError(error)) {
          // Native records terminal state before sending its notification; only
          // the terminal status or retirement can settle this compaction.
          return;
        }
        embeddedAgentLog.warn("codex app-server compaction interrupt request failed", {
          threadId: params.threadId,
          turnId: compactionTurnId,
          reason: coerceErrorMessage(error),
        });
      });
  };
  const beginInterruptGrace = () => {
    if (settled || !requestStarted || interruptGraceTimeout) {
      return;
    }
    requestInterrupt();
    interruptGraceTimeout = setTimeout(
      () => {
        embeddedAgentLog.warn(
          "codex app-server compaction did not reach terminal state after interruption",
          {
            threadId: params.threadId,
            turnId: compactionTurnId,
            interruptGraceMs: params.interruptGraceMs,
          },
        );
        retireUnconfirmed(
          "codex app-server compaction did not reach terminal state after interruption",
        );
      },
      Math.max(1, params.interruptGraceMs),
    );
    interruptGraceTimeout.unref?.();
  };
  const beginCompletionTimeout = () => {
    completionTimeout = setTimeout(
      () => {
        abortRequested = true;
        beginInterruptGrace();
        // Keep the shared client lease and per-thread fence through terminal state or
        // forced process retirement; releasing earlier could overlap the same transcript.
        embeddedAgentLog.warn("codex app-server compaction exceeded its completion budget", {
          threadId: params.threadId,
          timeoutMs: params.timeoutMs,
          interruptRequested,
        });
      },
      Math.max(1, params.timeoutMs),
    );
    completionTimeout.unref?.();
  };
  removeNotificationHandler = params.client.addNotificationHandler((notification) => {
    if (!requestStarted) {
      return;
    }
    if (!isJsonObject(notification.params)) {
      return;
    }
    if (readCodexNotificationThreadId(notification.params) !== params.threadId) {
      return;
    }
    const notificationTurnId = readCodexNotificationTurnId(notification.params);
    if (notification.method === "turn/started") {
      compactionTurnId = notificationTurnId;
      requestInterrupt();
      return;
    }
    if (compactionTurnId && notificationTurnId !== compactionTurnId) {
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      tokensAfter =
        readCodexThreadContextSnapshot(notification.params).activeContextTokens ?? tokensAfter;
      return;
    }
    const item = readCodexNotificationItem(notification.params);
    if (item?.type === "contextCompaction") {
      if (notification.method === "item/started") {
        compactionTurnId = compactionTurnId ?? notificationTurnId;
        if (!compactionItemId && compactionTurnId) {
          try {
            params.onCompactionTurn?.(compactionTurnId);
          } catch (error) {
            admissionFailure = coerceErrorMessage(error);
            abortRequested = true;
            beginInterruptGrace();
          }
        }
        compactionItemId = item.id;
        requestInterrupt();
        return;
      }
      if (notification.method === "item/completed" && compactionItemId === item.id) {
        compactionItemCompleted = true;
        return;
      }
    }
    if (
      notification.method !== "turn/completed" ||
      !compactionTurnId ||
      notificationTurnId !== compactionTurnId
    ) {
      return;
    }
    const turn = isJsonObject(notification.params.turn) ? notification.params.turn : undefined;
    const status = typeof turn?.status === "string" ? turn.status : undefined;
    if (admissionFailure) {
      fail(admissionFailure);
      return;
    }
    if (status !== "completed") {
      fail(`codex app-server compaction turn ended with status ${status ?? "unknown"}`);
      return;
    }
    const incompleteReason = !compactionItemId
      ? "codex app-server compaction turn completed without a compaction item"
      : !compactionItemCompleted
        ? "codex app-server compaction turn completed before its compaction item"
        : undefined;
    if (incompleteReason) {
      fail(incompleteReason);
      return;
    }
    complete();
  });
  removeCloseHandler = params.client.addCloseHandler(() => {
    retireUnconfirmed("codex app-server closed before native compaction completed");
  });
  if (params.signal) {
    const onAbort = () => {
      abortRequested = true;
      beginInterruptGrace();
    };
    params.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortHandler = () => params.signal?.removeEventListener("abort", onAbort);
    if (params.signal.aborted) {
      onAbort();
    }
  }
  return {
    completion,
    beginRequest: () => {
      requestStarted = true;
      beginCompletionTimeout();
      if (abortRequested) {
        beginInterruptGrace();
      }
    },
    confirmRequestRejected: () => fail("codex app-server rejected the compaction request"),
    retireUnconfirmedRequest: async (reason: string) => {
      retireUnconfirmed(reason);
      return await completion;
    },
    cancel: () => {
      if (!requestStarted) {
        fail("compaction request did not start");
      }
    },
  };
}
