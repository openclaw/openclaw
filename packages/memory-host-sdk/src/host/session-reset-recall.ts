import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type SessionResetRecallCutoff =
  | { state: "absent" }
  | { state: "invalid" }
  | { cutoffLine: number; state: "valid" };

/** Resolves the first raw transcript line owned by the current reset generation. */
export function resolveSessionResetRecallCutoff(
  events: readonly unknown[],
): SessionResetRecallCutoff {
  const resetIndex = events.findLastIndex((event) => asOptionalRecord(event)?.type === "reset");
  if (resetIndex < 0) {
    return { state: "absent" };
  }
  const reset = events[resetIndex] as { firstKeptEntryId?: unknown };
  if (reset.firstKeptEntryId === undefined) {
    return { state: "valid", cutoffLine: resetIndex + 1 };
  }
  if (typeof reset.firstKeptEntryId !== "string" || !reset.firstKeptEntryId.trim()) {
    return { state: "invalid" };
  }
  const keptIndex = events.findIndex(
    (event, index) => index < resetIndex && asOptionalRecord(event)?.id === reset.firstKeptEntryId,
  );
  return keptIndex < 0 ? { state: "invalid" } : { state: "valid", cutoffLine: keptIndex + 1 };
}
