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
  /** Wall-clock admission/receipt timestamp; drives deadlineAtMs emitted to queue owners (command-queue compares it against Date.now()). */
  startedAtMs: number;
  /** Monotonic timestamp captured at the same moment as startedAtMs. When set, the armed timer and elapsed accounting use performance.now() so wall-clock jumps cannot stretch or shrink the budget. When undefined, the deadline falls back to wall-clock (Date.now()). */
  startedAtMonotonicMs?: number;
  timeoutMs: number;
};

/** Tracks execution and local settlement against their original absolute deadlines. */
export function createAgentHarnessAttemptDeadlineController(params: {
  startedAtMs: number;
  timeoutMs: number;
  settlementTimeoutMs: number;
  signal: AbortSignal;
  onDeadlineChanged?: (
    deadline: { kind: "bounded"; deadlineAtMs: number } | { kind: "unlimited" },
  ) => void;
  onTimeout: (timeout: AgentHarnessAttemptTimeout) => void;
}) {
  let deadline: Deadline | { kind: "unlimited" } | { kind: "closed" } = { kind: "closed" };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const armDeadline = (next: Deadline) => {
    clearTimeout(timer);
    deadline = next;
    // deadlineAtMs stays in the wall-clock domain: queue owners (command-queue)
    // compare it against Date.now(), so it must remain epoch-based.
    const deadlineAtMs = next.startedAtMs + next.timeoutMs;
    params.onDeadlineChanged?.({ kind: "bounded", deadlineAtMs });
    // When a monotonic seed is present, measure the remaining budget with
    // performance.now() so NTP corrections, sleep/resume or manual clock changes
    // cannot stretch or shrink the configured timeout. Without the seed the
    // deadline falls back to wall-clock (Date.now()).
    const nowMs = next.startedAtMonotonicMs === undefined ? Date.now() : performance.now();
    const startedMs = next.startedAtMonotonicMs ?? next.startedAtMs;
    const remainingMs = next.timeoutMs - (nowMs - startedMs);
    timer = setTimeout(
      () => {
        if (deadline !== next || params.signal.aborted) {
          return;
        }
        deadline = { kind: "closed" };
        const firedNowMs = next.startedAtMonotonicMs === undefined ? Date.now() : performance.now();
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
      (deadline.kind === "execution" && Date.now() < deadline.startedAtMs + deadline.timeoutMs),
    beginSettlement: (startedAtMs: number, startedAtMonotonicMs?: number) => {
      if (deadline.kind === "closed" || deadline.kind === "settlement") {
        return;
      }
      // Native receipt or an explicit local terminal result ends execution, not
      // projection. The first boundary owns the absolute settlement deadline.
      // The monotonic seed keeps the settlement timer bounded against wall-clock
      // jumps; deadlineAtMs above stays wall-clock for queue owners.
      armDeadline({
        kind: "settlement",
        startedAtMs,
        startedAtMonotonicMs,
        timeoutMs: params.settlementTimeoutMs,
      });
    },
    dispose,
  };
}
