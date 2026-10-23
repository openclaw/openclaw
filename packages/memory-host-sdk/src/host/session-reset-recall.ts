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
  const reset = asOptionalRecord(events[resetIndex])!;
  return resolveSessionResetRecallBoundary(reset.firstKeptEntryId, resetIndex, (entryId) =>
    events.findIndex(
      (event, index) => index < resetIndex && asOptionalRecord(event)?.id === entryId,
    ),
  );
}

/** Shared validation for array snapshots and bounded immutable-source lookup. */
export function resolveSessionResetRecallBoundary(
  firstKeptEntryId: unknown,
  resetIndex: number,
  findKeptIndex: (entryId: string) => number,
): SessionResetRecallCutoff {
  if (firstKeptEntryId === undefined) {
    return { state: "valid", cutoffLine: resetIndex + 1 };
  }
  if (typeof firstKeptEntryId !== "string" || !firstKeptEntryId.trim()) {
    return { state: "invalid" };
  }
  const keptIndex = findKeptIndex(firstKeptEntryId);
  return keptIndex < 0 ? { state: "invalid" } : { state: "valid", cutoffLine: keptIndex + 1 };
}
