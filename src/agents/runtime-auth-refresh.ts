import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withTimeout } from "../infra/fs-safe.js";
import type { CommandQueueTaskDeadline } from "../process/command-queue.types.js";
import { monotonicNow } from "../shared/monotonic-time.js";
/** Bound caller-owned exchanges; native OAuth owners retain durable refresh settlement. */
export function createRuntimeAuthDeadline(params: {
  provider: string;
  timeoutMs: number;
  signal?: AbortSignal;
  getDeadline?: () => CommandQueueTaskDeadline | undefined;
}) {
  const authAbort = new AbortController();
  const authSignal = params.signal
    ? AbortSignal.any([params.signal, authAbort.signal])
    : authAbort.signal;
  const timeoutMs = params.timeoutMs;
  const startupDeadline =
    timeoutMs < MAX_TIMER_TIMEOUT_MS
      ? { kind: "bounded" as const, deadlineAtMs: monotonicNow() + timeoutMs }
      : { kind: "unlimited" as const };
  const withAuthDeadline = <T>(
    step: string,
    operation: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> => {
    const signal = requestSignal ? AbortSignal.any([authSignal, requestSignal]) : authSignal;
    const deadline = params.getDeadline?.() ?? startupDeadline;
    // Each source stays in its own clock domain. The startup budget is seeded with
    // monotonicNow() at creation, so a host clock correction cannot move it. An upstream
    // command-queue deadline is a wall-clock epoch by contract; its remaining duration is
    // still measured against Date.now(), so a backward correction stretches that source —
    // an existing upstream limitation that this helper does not claim to fix.
    const remainingMs =
      deadline.kind === "bounded"
        ? Math.max(
            0,
            deadline === startupDeadline
              ? deadline.deadlineAtMs - monotonicNow()
              : deadline.deadlineAtMs - Date.now(),
          )
        : undefined;
    const expire = () => {
      const error = createAbortError(
        `${params.provider} ${step} timed out at the run deadline (${timeoutMs}ms). Check the provider's authentication service and retry the run.`,
      );
      authAbort.abort(error);
      return error;
    };
    if (remainingMs !== undefined && remainingMs <= 0) {
      return Promise.reject(expire());
    }
    return withTimeout(
      racePromiseWithAbortSignal(
        () => operation(signal),
        signal,
        () =>
          createAbortError(
            `${params.provider} ${step} aborted; authentication capability is closed. Retry the run when authentication is available.`,
          ),
      ),
      remainingMs ?? 0,
      { createError: expire },
    );
  };
  return { run: withAuthDeadline, signal: authSignal, cancel: () => authAbort.abort() };
}
