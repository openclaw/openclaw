import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionEntry } from "../sessions/session-manager-types.js";

/**
 * The history a prompt series belongs to: the newest compaction or reset, null before any.
 * A bounded window can start after that entry. Then the newest prompt checkpoint names it, but
 * only when it records the same boundary count as the transcript: a checkpoint written before a
 * later compaction belongs to the earlier history. Without that evidence the history is unknown.
 * Checkpoints from before the count was recorded are unknown once the session has a boundary.
 */
function readHistoryId(entries: SessionEntry[], boundaryCount: number | undefined) {
  const boundary = entries.findLast((e) => e.type === "compaction" || e.type === "reset");
  if (boundary) {
    return boundary.id;
  }
  const checkpoint = entries.findLast(
    (e) =>
      e.type === "custom" &&
      e.customType === "openclaw.system-prompt" &&
      isRecord(e.data) &&
      "historyId" in e.data,
  );
  const data = checkpoint?.type === "custom" && isRecord(checkpoint.data) ? checkpoint.data : {};
  if (
    boundaryCount === undefined ||
    data.boundaryCount === boundaryCount ||
    (boundaryCount === 0 && data.boundaryCount === undefined)
  ) {
    // SAFETY: session-prompt-state alone writes openclaw.system-prompt checkpoints; historyId is string | null.
    return (data.historyId as string | null | undefined) ?? null;
  }
  return undefined;
}

/**
 * Omit the boundary count only for a view that holds the newest boundary. An unknown history
 * gets an id of its own for this attempt, so it never matches a saved series and restarts once.
 */
export function resolvePromptHistoryId(params: {
  state: { historyBoundary?: { count: number; id: string | null } };
  entries: SessionEntry[];
  historyBoundaryCount?: number;
}): string | null {
  // Bounded reloads can omit a compaction's payload without changing history.
  // The manager's boundary count, not its visible window, invalidates this run's fact.
  const previous = params.state.historyBoundary;
  if (previous && previous.count === params.historyBoundaryCount) {
    return previous.id;
  }
  const read = readHistoryId(params.entries, params.historyBoundaryCount);
  const id = read === undefined ? `unknown:${randomUUID()}` : read;
  if (params.historyBoundaryCount !== undefined) {
    params.state.historyBoundary = { count: params.historyBoundaryCount, id };
  }
  return id;
}
