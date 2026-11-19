import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { resolveSessionControllerOperationForSignal } from "../../sessions/session-controller.state.js";
import { SESSION_WATCHDOG_WARNING_MS } from "../../sessions/session-controller.watchdog-state.js";

/** Keep a quiet compaction inside compaction.timeoutSeconds from looking stalled. */
export async function withCompactionWatchdogAllowance<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const operation =
    getCurrentSessionControllerOwner() ?? resolveSessionControllerOperationForSignal(signal);
  if (!operation || !operation.watchdog.snapshot().hasActiveAttempt) {
    return await work();
  }
  let attempt;
  try {
    attempt = operation.watchdog.attachAttempt({
      nested: true,
      assertCurrent() {},
    });
  } catch {
    return await work();
  }
  const closeRequest = attempt.beginRequest({
    deadlineAtMs: Date.now() + Math.max(0, timeoutMs),
  });
  try {
    return await work();
  } finally {
    // Dropping the request without grace makes the quiet turn stall immediately.
    closeRequest(Date.now() + SESSION_WATCHDOG_WARNING_MS);
    attempt.close();
  }
}
