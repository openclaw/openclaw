import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionEntry } from "../sessions/session-manager-types.js";

/**
 * The history a prompt series belongs to: the newest compaction or reset, null before any.
 * The count changes only at a compaction or reset on the active path, so the newest prompt
 * checkpoint that records the transcript's count was written in the current history and names
 * it, even when the boundary is also in the window. A bounded window can start after the
 * boundary; a checkpoint with another count belongs to an earlier history. Without that
 * evidence the history is unknown. Checkpoints from before the count was recorded are unknown
 * once the session has a boundary.
 */
function readHistoryId(entries: SessionEntry[], boundaryCount: number | undefined) {
  const checkpoint = entries.findLast(
    (e) =>
      e.type === "custom" &&
      e.customType === "openclaw.system-prompt" &&
      isRecord(e.data) &&
      "historyId" in e.data,
  );
  const data = checkpoint?.type === "custom" && isRecord(checkpoint.data) ? checkpoint.data : {};
  // SAFETY: session-prompt-state alone writes openclaw.system-prompt checkpoints; historyId is string | null.
  const checkpointId = (data.historyId as string | null | undefined) ?? null;
  if (boundaryCount !== undefined && data.boundaryCount === boundaryCount) {
    return checkpointId;
  }
  const boundary = entries.findLast((e) => e.type === "compaction" || e.type === "reset");
  if (boundary) {
    return boundary.id;
  }
  if (boundaryCount === undefined || (boundaryCount === 0 && data.boundaryCount === undefined)) {
    return checkpointId;
  }
  return undefined;
}

/**
 * Omit the boundary count only for a view that holds the newest boundary. An unknown history is
 * named by its count: the count changes only at a compaction or reset on the active path, so a
 * checkpoint that recorded `unknown:N` at count N belongs to the same history. The series
 * restarts once each time the newest checkpoint and the boundary both leave the window.
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
  const id = read === undefined ? `unknown:${params.historyBoundaryCount}` : read;
  if (params.historyBoundaryCount !== undefined) {
    params.state.historyBoundary = { count: params.historyBoundaryCount, id };
  }
  return id;
}
