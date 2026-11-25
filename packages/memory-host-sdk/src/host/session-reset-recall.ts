import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type SessionResetRecallCutoff =
  | { state: "absent" }
  | { state: "invalid" }
  | { cutoffLine: number; state: "valid" };

/**
 * Tracks the first raw transcript line owned by the current reset generation while events
 * stream in source order. Retains one index per event id, never event bodies.
 */
export function createSessionResetRecallCutoffTracker() {
  const firstIndexById = new Map<string, number>();
  let cutoff: SessionResetRecallCutoff = { state: "absent" };
  let index = 0;
  return {
    observe(event: unknown): void {
      const record = asOptionalRecord(event);
      if (record?.type === "reset") {
        const keptId = record.firstKeptEntryId;
        if (keptId === undefined) {
          cutoff = { state: "valid", cutoffLine: index + 1 };
        } else if (typeof keptId !== "string" || !keptId.trim()) {
          cutoff = { state: "invalid" };
        } else {
          const keptIndex = firstIndexById.get(keptId);
          cutoff =
            keptIndex === undefined
              ? { state: "invalid" }
              : { state: "valid", cutoffLine: keptIndex + 1 };
        }
      }
      if (typeof record?.id === "string" && !firstIndexById.has(record.id)) {
        firstIndexById.set(record.id, index);
      }
      index++;
    },
    current(): SessionResetRecallCutoff {
      return { ...cutoff };
    },
  };
}

/** Resolves the first raw transcript line owned by the current reset generation. */
export function resolveSessionResetRecallCutoff(
  events: readonly unknown[],
): SessionResetRecallCutoff {
  const tracker = createSessionResetRecallCutoffTracker();
  for (const event of events) {
    tracker.observe(event);
  }
  return tracker.current();
}
