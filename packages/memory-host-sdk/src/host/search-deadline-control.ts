/**
 * Per-call control channel between a memory-search deadline owner and a nested
 * phase that runs on its own budget. The canonical example is managed
 * local-service acquisition during query embedding: service readiness is owned
 * and bounded by `models.providers.<id>.localService.readyTimeoutMs`, so the
 * whole-search deadline must not consume its budget while the caller waits for
 * a cold service to become ready.
 *
 * The channel is symbol-keyed so it never serializes into tool payloads or
 * provider request bodies and stays invisible to model-facing surfaces.
 */
export const MEMORY_SEARCH_DEADLINE_CONTROL: unique symbol = Symbol(
  "openclaw.memory-search-deadline-control",
);

export type MemorySearchDeadlineControlAction = "pause" | "resume";

/**
 * Owned phases call `report`; deadline owners `subscribe`.
 *
 * The control owner balances concurrent owned phases: subscribers see "pause"
 * only on the 0→1 transition and "resume" only on the final 1→0 transition, so
 * overlapping owned phases cannot re-arm a budget early. Caller cancellation
 * never passes through this channel; it stays on the AbortSignal.
 */
export type MemorySearchDeadlineControl = {
  report: (action: MemorySearchDeadlineControlAction) => void;
  subscribe: (listener: (action: MemorySearchDeadlineControlAction) => void) => () => void;
};

export type MemorySearchDeadlineControlOptions = {
  [MEMORY_SEARCH_DEADLINE_CONTROL]?: MemorySearchDeadlineControl;
};

/** Create the balanced fan-out at the deadline owner boundary. */
export function createMemorySearchDeadlineControl(): MemorySearchDeadlineControl {
  let depth = 0;
  const listeners = new Set<(action: MemorySearchDeadlineControlAction) => void>();
  return {
    report(action) {
      if (action === "pause") {
        depth += 1;
        if (depth === 1) {
          for (const listener of listeners) {
            listener("pause");
          }
        }
        return;
      }
      if (depth === 0) {
        return;
      }
      depth -= 1;
      if (depth === 0) {
        for (const listener of listeners) {
          listener("resume");
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      // A subscriber that attaches mid-phase must observe the current pause so
      // its budget accounting matches the owners that were present at report time.
      if (depth > 0) {
        listener("pause");
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
