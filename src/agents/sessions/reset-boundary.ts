import { selectRecentUserAssistantReplayRecords } from "../../config/sessions/transcript-replay.js";
import { SessionManager, type ResetReason, type SessionMessageEntry } from "./session-manager.js";

export type AppendedSessionResetBoundary = {
  boundaryEntryId: string;
  firstKeptEntryId?: string;
  keptEntryIds: string[];
};

/** Append one reset boundary while retaining the same alternating tail as legacy replay. */
export function appendSessionResetBoundary(params: {
  reason: ResetReason;
  sessionFile: string | undefined;
}): AppendedSessionResetBoundary | undefined {
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return undefined;
  }
  try {
    const manager = SessionManager.open(sessionFile);
    const keptEntries = selectRecentUserAssistantReplayRecords(
      manager.getBranch(),
    ) as SessionMessageEntry[];
    const firstKeptEntryId = keptEntries[0]?.id;
    return {
      boundaryEntryId: manager.appendResetBoundary(params.reason, firstKeptEntryId),
      ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
      keptEntryIds: keptEntries.map((entry) => entry.id),
    };
  } catch {
    return undefined;
  }
}
