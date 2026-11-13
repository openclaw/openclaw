import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionEntry } from "../sessions/session-manager-types.js";

/** Newest compaction/reset id; a window starting after it uses the checkpoint written in it. */
function readHistoryId(entries: SessionEntry[]): string | null {
  const entry = entries.findLast(
    (e) =>
      e.type === "compaction" ||
      e.type === "reset" ||
      (e.type === "custom" &&
        e.customType === "openclaw.system-prompt" &&
        isRecord(e.data) &&
        "historyId" in e.data),
  );
  return entry?.type === "custom"
    ? // SAFETY: session-prompt-state alone writes openclaw.system-prompt checkpoints; historyId is string | null.
      ((entry.data as { historyId?: string | null }).historyId ?? null)
    : (entry?.id ?? null);
}

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
  const id = readHistoryId(params.entries);
  if (params.historyBoundaryCount !== undefined) {
    params.state.historyBoundary = { count: params.historyBoundaryCount, id };
  }
  return id;
}
