import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  waitForReplyRunEndBySessionId,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  EMBEDDED_RUN_WAITERS,
  type EmbeddedAgentQueueHandle,
  type EmbeddedRunWaiter,
} from "./run-state.js";

export function waitForCurrentEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null,
  handle?: EmbeddedAgentQueueHandle,
  preserveReplyRun?: ReplyOperation,
): Promise<boolean> {
  const isHandleActive = () =>
    handle ? ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle : ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (!isHandleActive()) {
    if (handle) {
      return Promise.resolve(true);
    }
    return waitForReplyRunEndBySessionId(sessionId, timeoutMs, preserveReplyRun);
  }
  const timeoutLabel = timeoutMs === null ? "none" : String(timeoutMs);
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutLabel}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      handle,
    };
    if (timeoutMs !== null) {
      waiter.timer = setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        resolveTimerTimeoutMs(timeoutMs, 100, 100),
      );
    }
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!isHandleActive()) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      resolve(true);
    }
  });
}
