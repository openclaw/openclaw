import type {
  EmbeddingDeadlineControl,
  EmbeddingDeadlineControlOptions,
} from "../../../../src/plugins/embedding-provider-types.js";

// Keep existing memory callers on the same per-call channel as embedding providers.
export { EMBEDDING_DEADLINE_CONTROL as MEMORY_SEARCH_DEADLINE_CONTROL } from "../../../../src/plugins/embedding-provider-types.js";

type MemorySearchDeadlineControlAction = "pause" | "resume";

export type MemorySearchDeadlineControl = EmbeddingDeadlineControl;

export type MemorySearchDeadlineControlOptions = EmbeddingDeadlineControlOptions;

/** Create the balanced fan-out at the deadline owner boundary. */
export function createMemorySearchDeadlineControl(): MemorySearchDeadlineControl {
  let depth = 0;
  const listeners = new Set<(action: MemorySearchDeadlineControlAction) => void>();
  return {
    report(action) {
      if (action === "pause") {
        depth += 1;
        if (depth !== 1) {
          return;
        }
      } else if (depth === 0 || --depth !== 0) {
        return;
      }
      for (const listener of listeners) {
        listener(action === "pause" ? "pause" : "resume");
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
