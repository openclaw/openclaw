import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { MemorySearchDeadlineControl } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

export function createPausedDeadline(params: {
  kind: "corpus" | "embedding";
  timeoutMs: number;
  signal: AbortSignal;
  control?: MemorySearchDeadlineControl;
  expire: () => void;
}) {
  // setTimeout is monotonic. A wall-clock jump must not consume or invent pause budget.
  const now = () => performance.now();
  let remainingMs = params.timeoutMs;
  let segmentStartedAt = now();
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    segmentStartedAt = now();
    timer = setTimeout(() => {
      timer = undefined;
      params.expire();
    }, remainingMs);
    if (params.kind === "corpus") {
      timer.unref?.();
    }
  };
  const unsubscribe = params.control?.subscribe((action) => {
    if (params.kind === "corpus" && params.signal.aborted) {
      return;
    }
    paused = action === "pause";
    if (paused) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      remainingMs = Math.max(0, remainingMs - (now() - segmentStartedAt));
      // An already-consumed budget cannot gain time by entering an exempt phase.
      if (remainingMs === 0) {
        params.expire();
      }
    } else if (!params.signal.aborted) {
      arm();
    }
  });
  return {
    start() {
      if (!paused) {
        arm();
      }
    },
    isExpired: () => !paused && now() - segmentStartedAt >= remainingMs,
    close() {
      unsubscribe?.();
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

export async function runEmbeddingOperationWithTimeout<T>(params: {
  timeoutMs: number;
  message: string;
  /** Caller-owned cancellation, merged with the per-call watchdog abort. */
  signal?: AbortSignal;
  /** Managed readiness pauses this watchdog, while caller cancellation stays active. */
  deadlineControl?: MemorySearchDeadlineControl;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    return await params.run(signal);
  }
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const timeoutError = new Error(params.message);
  const timeout = createDeferred<never>();
  const deadline = createPausedDeadline({
    kind: "embedding",
    timeoutMs,
    signal,
    control: params.deadlineControl,
    expire: () => {
      timeout.reject(timeoutError);
      controller.abort(timeoutError);
    },
  });
  deadline.start();
  try {
    const operation = params.run(signal);
    const result = await Promise.race([operation, timeout.promise]);
    params.signal?.throwIfAborted();
    // An overdue watchdog can run after provider success following an event-loop stall.
    if (deadline.isExpired()) {
      controller.abort(timeoutError);
      throw timeoutError;
    }
    return result;
  } finally {
    deadline.close();
  }
}
