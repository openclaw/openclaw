import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";

export type AgentHarnessAttemptTimeout = {
  kind: "execution" | "settlement";
  elapsedMs: number;
  timeoutMs: number;
};

type Deadline = {
  kind: AgentHarnessAttemptTimeout["kind"];
  startedAtMs: number;
  timeoutMs: number;
};

/** Tracks execution and local settlement against their original absolute deadlines. */
export function createAgentHarnessAttemptDeadlineController(params: {
  startedAtMs: number;
  /**
   * Captured alongside startedAtMs, before asynchronous attempt preparation.
   * Official runtime plugins released before 2026.10.6 omit it.
   */
  startedAtMonotonicMs?: number;
  timeoutMs: number;
  settlementTimeoutMs: number;
  signal: AbortSignal;
  onDeadlineChanged?: (
    deadline: { kind: "bounded"; deadlineAtMs: number } | { kind: "unlimited" },
  ) => void;
  onTimeout: (timeout: AgentHarnessAttemptTimeout) => void;
}) {
  // Older version-bound plugins still pass only the epoch start; anchor it to the
  // monotonic clock once so their admitted budget survives instead of becoming NaN.
  const providedMonotonicMs = params.startedAtMonotonicMs;
  const startedAtMonotonicMs =
    providedMonotonicMs !== undefined && Number.isFinite(providedMonotonicMs)
      ? providedMonotonicMs
      : performance.now() - Math.max(0, Date.now() - params.startedAtMs);
  let deadline: Deadline | { kind: "unlimited" } | { kind: "closed" } = { kind: "closed" };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const armDeadline = (next: Deadline) => {
    clearTimeout(timer);
    deadline = next;
    // Queue receipts remain epoch-based; only execution elapsed time is monotonic.
    const deadlineAtMs = next.startedAtMs + next.timeoutMs;
    params.onDeadlineChanged?.({ kind: "bounded", deadlineAtMs });
    const nowMs = next.kind === "execution" ? performance.now() : Date.now();
    const startedMs = next.kind === "execution" ? startedAtMonotonicMs : next.startedAtMs;
    const remainingMs = next.timeoutMs - (nowMs - startedMs);
    timer = setTimeout(
      () => {
        if (deadline !== next || params.signal.aborted) {
          return;
        }
        deadline = { kind: "closed" };
        const firedNowMs = next.kind === "execution" ? performance.now() : Date.now();
        params.onTimeout({
          kind: next.kind,
          elapsedMs: Math.max(0, firedNowMs - startedMs),
          timeoutMs: next.timeoutMs,
        });
      },
      resolveTimerTimeoutMs(Math.max(1, remainingMs), 1),
    );
    timer.unref?.();
  };
  const dispose = () => {
    deadline = { kind: "closed" };
    clearTimeout(timer);
    params.signal.removeEventListener("abort", dispose);
  };
  if (!params.signal.aborted) {
    params.signal.addEventListener("abort", dispose, { once: true });
    if (params.timeoutMs >= MAX_TIMER_TIMEOUT_MS) {
      deadline = { kind: "unlimited" };
      params.onDeadlineChanged?.({ kind: "unlimited" });
    } else {
      armDeadline({
        kind: "execution",
        startedAtMs: params.startedAtMs,
        timeoutMs: params.timeoutMs,
      });
    }
  }

  return {
    ownsExecutionWait: () =>
      deadline.kind === "unlimited" ||
      (deadline.kind === "execution" &&
        performance.now() < startedAtMonotonicMs + deadline.timeoutMs),
    beginSettlement: (startedAtMs: number) => {
      if (deadline.kind === "closed" || deadline.kind === "settlement") {
        return;
      }
      // Native receipt or an explicit local terminal result ends execution, not
      // projection. The first boundary owns the absolute settlement deadline.
      armDeadline({
        kind: "settlement",
        startedAtMs,
        timeoutMs: params.settlementTimeoutMs,
      });
    },
    dispose,
  };
}
