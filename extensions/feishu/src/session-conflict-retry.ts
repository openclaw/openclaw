// Feishu plugin module implements inbound dispatch retry for reply-session init conflicts.
// Parity target: Signal (extensions/signal/src/monitor/event-handler.ts:686-721)
// wraps bounded retry for the same conflict pattern with 1s/2s/4s backoff.
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";

// The message shape is the cross-channel retry classification contract raised
// by core reply-session initialization (see ReplySessionInitConflictError).
const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;
// Bounded backoff ladder before declaring the inbound message lost.
const FEISHU_SESSION_INIT_CONFLICT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/** Shown to the sender after all retries are exhausted. */
export const FEISHU_SESSION_CONFLICT_FAILURE_TEXT =
  "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.";

export function isFeishuReplySessionInitConflictError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).some(
    (candidate) => REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(formatErrorMessage(candidate)),
  );
}

/**
 * Raised when a session-init conflict survives every channel retry delay;
 * callers owe the sender a visible loss notice.
 */
export class FeishuSessionConflictExhaustedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeishuSessionConflictExhaustedError";
  }
}

/**
 * Retries only reply-session init conflicts with a bounded 1s/2s/4s backoff;
 * other failures propagate immediately so the dispatch catch keeps existing
 * logging behavior. Each retry rebuilds the dispatcher — a settled dispatcher
 * must not carry queued/settled state into a retry, so the caller must supply
 * a fresh dispatch function per attempt.
 */
export async function runFeishuDispatchWithSessionInitConflictRetry<T>(params: {
  dispatch: () => Promise<T>;
  onRetry?: (attempt: number, delayMs: number) => void;
}): Promise<T> {
  for (let retryIndex = 0; ; retryIndex += 1) {
    try {
      return await params.dispatch();
    } catch (error) {
      if (!isFeishuReplySessionInitConflictError(error)) {
        throw error;
      }
      const delayMs = FEISHU_SESSION_INIT_CONFLICT_RETRY_DELAYS_MS[retryIndex];
      if (delayMs === undefined) {
        throw new FeishuSessionConflictExhaustedError(
          `reply session init conflict persisted after channel retries: ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }
      params.onRetry?.(retryIndex + 1, delayMs);
      await sleepWithAbort(delayMs);
    }
  }
}
