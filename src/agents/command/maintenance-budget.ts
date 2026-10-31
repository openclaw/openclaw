import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createAbortError } from "../../infra/abort-signal.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { monotonicNow, remainingMonotonicMs } from "../../shared/monotonic-time.js";

const log = createSubsystemLogger("agents/agent-command");

export function createCommandBudget(startedAt: number, timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  // Project the caller's epoch-valued start once: setTimeout counts down on the monotonic
  // clock, so a wall-clock correction must not move the deadline it is counting toward.
  const startedAtMonotonic = monotonicNow() - Math.max(0, Date.now() - startedAt);
  const deadline = timeoutMs === MAX_TIMER_TIMEOUT_MS ? undefined : startedAtMonotonic + timeoutMs;
  const expire = () => {
    if (!controller.signal.aborted) {
      controller.abort(createAbortError("Command reached its deadline"));
      log.debug("Command work stopped at its deadline.");
    }
  };
  const remainingMs = () => {
    const remaining = controller.signal.aborted
      ? 0
      : deadline === undefined
        ? timeoutMs
        : Math.max(0, Math.floor(remainingMonotonicMs(deadline)));
    if (remaining === 0) {
      expire();
    }
    return remaining;
  };
  const remaining = remainingMs();
  const timer = deadline !== undefined && remaining > 0 ? setTimeout(expire, remaining) : undefined;
  timer?.unref();
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    remainingMs,
    dispose: () => clearTimeout(timer),
  };
}
