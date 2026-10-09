import type { MemorySearchDeadlineControl } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function createPausedDeadline(params: {
  kind: "corpus" | "embedding";
  timeoutMs: number;
  signal: AbortSignal;
  control?: MemorySearchDeadlineControl;
  expire: () => void;
}) {
  const now = params.kind === "corpus" ? () => performance.now() : () => Date.now();
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
