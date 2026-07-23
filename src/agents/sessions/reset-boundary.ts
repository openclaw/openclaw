import { randomUUID } from "node:crypto";
import {
  appendTranscriptEventSync,
  appendTranscriptLifecycleEventSync,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { selectRecentUserAssistantReplayRecords } from "../../config/sessions/transcript-replay.js";
import { SessionManager, type ResetReason, type SessionMessageEntry } from "./session-manager.js";

export type AppendedSessionResetBoundary = {
  boundaryEntryId: string;
  firstKeptEntryId?: string;
  insideLifecycleMutation?: true;
  keptEntryIds: string[];
  previousLeafId: string | null;
  sessionFile: string;
  sessionKey?: string;
};

function hasPersistedBoundary(params: {
  boundaryEntryId: string;
  sessionFile: string;
  sessionKey?: string;
}): boolean {
  const marker = parseSqliteSessionFileMarker(params.sessionFile);
  if (!marker) {
    return SessionManager.open(params.sessionFile).getEntry(params.boundaryEntryId) !== undefined;
  }
  return loadTranscriptEventsSync({
    agentId: marker.agentId,
    sessionId: marker.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    storePath: marker.storePath,
  }).some(
    (event) =>
      event !== null &&
      typeof event === "object" &&
      (event as { id?: unknown }).id === params.boundaryEntryId,
  );
}

/** Append one reset boundary while retaining the same alternating tail as legacy replay. */
export function appendSessionResetBoundary(params: {
  insideLifecycleMutation?: boolean;
  reason: ResetReason;
  sessionFile: string | undefined;
  sessionKey?: string;
}): AppendedSessionResetBoundary | undefined {
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return undefined;
  }
  const manager = SessionManager.open(sessionFile);
  const keptEntries = selectRecentUserAssistantReplayRecords(
    manager.getBranch(),
  ) as SessionMessageEntry[];
  const firstKeptEntryId = keptEntries[0]?.id;
  const previousLeafId = manager.getLeafId();
  const boundaryEntryId = manager.appendResetBoundary(params.reason, firstKeptEntryId);
  const persistenceSessionKey = params.insideLifecycleMutation ? undefined : params.sessionKey;
  if (
    !hasPersistedBoundary({
      boundaryEntryId,
      sessionFile,
      sessionKey: persistenceSessionKey,
    })
  ) {
    const marker = parseSqliteSessionFileMarker(sessionFile);
    const boundaryEntry = manager.getEntry(boundaryEntryId);
    if (params.insideLifecycleMutation && (!marker || !boundaryEntry)) {
      throw new Error("reset boundary lifecycle append requires a SQLite transcript target");
    }
    if (marker && boundaryEntry) {
      (params.insideLifecycleMutation
        ? appendTranscriptLifecycleEventSync
        : appendTranscriptEventSync)(
        {
          agentId: marker.agentId,
          sessionId: marker.sessionId,
          ...(persistenceSessionKey ? { sessionKey: persistenceSessionKey } : {}),
          storePath: marker.storePath,
        },
        boundaryEntry,
      );
    }
    if (
      !params.insideLifecycleMutation &&
      !hasPersistedBoundary({
        boundaryEntryId,
        sessionFile,
        sessionKey: persistenceSessionKey,
      })
    ) {
      throw new Error("reset boundary append was not persisted");
    }
  }
  return {
    boundaryEntryId,
    ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
    ...(params.insideLifecycleMutation ? { insideLifecycleMutation: true as const } : {}),
    keptEntryIds: keptEntries.map((entry) => entry.id),
    previousLeafId,
    sessionFile,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  };
}

/** Restore the pre-reset visible leaf when the paired lifecycle row commit fails. */
export function rollbackSessionResetBoundary(boundary: AppendedSessionResetBoundary): void {
  const marker = parseSqliteSessionFileMarker(boundary.sessionFile);
  if (!marker) {
    throw new Error("reset boundary rollback requires a SQLite transcript target");
  }
  const restored = (
    boundary.insideLifecycleMutation
      ? appendTranscriptLifecycleEventSync
      : appendTranscriptEventSync
  )(
    {
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      ...(boundary.sessionKey ? { sessionKey: boundary.sessionKey } : {}),
      storePath: marker.storePath,
    },
    {
      type: "leaf",
      id: randomUUID().slice(0, 8),
      parentId: boundary.boundaryEntryId,
      timestamp: new Date().toISOString(),
      targetId: boundary.previousLeafId,
      appendParentId: boundary.previousLeafId,
    },
  );
  if (!restored) {
    throw new Error("failed to restore transcript leaf after reset commit failure");
  }
}
