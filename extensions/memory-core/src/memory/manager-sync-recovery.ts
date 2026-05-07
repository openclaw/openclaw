// Helpers for snapshotting and restoring the in-memory sync state that tracks
// which files still need to be (re)indexed. Reindex rollback must put these
// back exactly where they were so the next sync retries the work that failed,
// instead of silently losing the dirty signal.
//
// Helpers accept plain fields rather than `this` so the manager class can keep
// `dirty` / `sessionsDirty` / etc. declared `protected`; TypeScript refuses to
// widen a `this` type to a plain structural type when the fields are
// non-public, so we pass values in and return merged values back.

export type SessionDeltaEntry = {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
};

export type MemorySyncStateSnapshot = {
  dirty: boolean;
  sessionsDirty: boolean;
  sessionsDirtyFiles: Set<string>;
  sessionPendingFiles: Set<string>;
  sessionDeltas: Map<string, SessionDeltaEntry>;
  sessionFullRetryPending: boolean;
};

export function snapshotSyncState(state: {
  dirty: boolean;
  sessionsDirty: boolean;
  sessionsDirtyFiles: ReadonlySet<string>;
  sessionPendingFiles: ReadonlySet<string>;
  sessionDeltas: ReadonlyMap<string, SessionDeltaEntry>;
  sessionFullRetryPending: boolean;
}): MemorySyncStateSnapshot {
  return {
    dirty: state.dirty,
    sessionsDirty: state.sessionsDirty,
    sessionsDirtyFiles: new Set(state.sessionsDirtyFiles),
    sessionPendingFiles: new Set(state.sessionPendingFiles),
    sessionDeltas: new Map(
      Array.from(state.sessionDeltas.entries()).map(([key, value]) => [key, { ...value }]),
    ),
    sessionFullRetryPending: state.sessionFullRetryPending,
  };
}

// Compute the restored sync state. Callers apply the fields back to `this`
// themselves.
//
// Semantics:
//   • `dirty`, `sessionsDirty` are sticky booleans: OR live on top of snapshot.
//   • `sessionsDirtyFiles`, `sessionPendingFiles` are unions.
//   • `sessionDeltas` is merged per-entry (see `mergeSessionDeltas`) so we do
//     not double-count pending bytes/messages that the failed reindex would
//     have consumed.
export function computeRestoredSyncState(
  live: {
    dirty: boolean;
    sessionsDirty: boolean;
    sessionsDirtyFiles: ReadonlySet<string>;
    sessionPendingFiles: ReadonlySet<string>;
    sessionDeltas: ReadonlyMap<string, SessionDeltaEntry>;
    sessionFullRetryPending: boolean;
  },
  snapshot: MemorySyncStateSnapshot,
): MemorySyncStateSnapshot {
  const sessionsDirtyFiles = new Set(live.sessionsDirtyFiles);
  for (const file of snapshot.sessionsDirtyFiles) {
    sessionsDirtyFiles.add(file);
  }
  const sessionPendingFiles = new Set(live.sessionPendingFiles);
  for (const file of snapshot.sessionPendingFiles) {
    sessionPendingFiles.add(file);
  }
  return {
    dirty: snapshot.dirty || live.dirty,
    sessionsDirty: snapshot.sessionsDirty || live.sessionsDirty || sessionsDirtyFiles.size > 0,
    sessionsDirtyFiles,
    sessionPendingFiles,
    sessionDeltas: mergeSessionDeltas(snapshot.sessionDeltas, live.sessionDeltas),
    sessionFullRetryPending: snapshot.sessionFullRetryPending || live.sessionFullRetryPending,
  };
}

// Merge two session delta maps. `base` is the pre-reindex snapshot, `live` is
// whatever has been accumulated concurrently during the failed reindex. When
// the same session file appears in both, the merge must:
//   • Take the larger `lastSize` (the file only grows from each indexer's
//     point of view, and `live` may already have seen newer appends).
//   • Use `Math.min` of the two `pendingBytes`/`pendingMessages` values so we
//     do not re-count bytes the live indexer has already folded into its own
//     tally — `live.pendingBytes` is measured against `live.lastSize`, so
//     anything older than that has already been handled.
export function mergeSessionDeltas(
  base: ReadonlyMap<string, SessionDeltaEntry>,
  live: ReadonlyMap<string, SessionDeltaEntry>,
): Map<string, SessionDeltaEntry> {
  const merged = new Map<string, SessionDeltaEntry>();
  for (const [key, entry] of base) {
    merged.set(key, { ...entry });
  }
  for (const [key, liveEntry] of live) {
    const baseEntry = merged.get(key);
    if (!baseEntry) {
      merged.set(key, { ...liveEntry });
      continue;
    }
    const indexedSize = Math.max(baseEntry.lastSize, liveEntry.lastSize);
    merged.set(key, {
      lastSize: indexedSize,
      pendingBytes: Math.min(baseEntry.pendingBytes, liveEntry.pendingBytes),
      pendingMessages: Math.min(baseEntry.pendingMessages, liveEntry.pendingMessages),
    });
  }
  return merged;
}

// Decide what to set `sessionFullRetryPending` to after a reindex attempt
// fails. Only failures that actually started the full session rebuild need the
// sentinel: the goal is to force the next sync to run the full path even if
// `sessionsDirtyFiles` was cleared earlier in the same run.
export function restoreRetryStateAfterReindexRollback(params: {
  previous: boolean;
  ranSessionFullRebuild: boolean;
}): boolean {
  return params.previous || params.ranSessionFullRebuild;
}
