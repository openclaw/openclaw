import { describe, expect, it } from "vitest";
import {
  computeRestoredSyncState,
  mergeSessionDeltas,
  restoreRetryStateAfterReindexRollback,
  snapshotSyncState,
  type SessionDeltaEntry,
} from "./manager-sync-recovery.js";

function delta(lastSize: number, pendingBytes: number, pendingMessages: number): SessionDeltaEntry {
  return { lastSize, pendingBytes, pendingMessages };
}

describe("snapshotSyncState", () => {
  it("creates deep copies of mutable collections", () => {
    const state = {
      dirty: true,
      sessionsDirty: false,
      sessionsDirtyFiles: new Set(["a"]),
      sessionPendingFiles: new Set(["b"]),
      sessionDeltas: new Map([["session-1", delta(10, 2, 1)]]),
      sessionFullRetryPending: false,
    };
    const snap = snapshotSyncState(state);
    state.sessionsDirtyFiles.add("mutation");
    state.sessionPendingFiles.add("mutation");
    state.sessionDeltas.get("session-1")!.pendingBytes = 999;
    expect(snap.sessionsDirtyFiles.has("mutation")).toBe(false);
    expect(snap.sessionPendingFiles.has("mutation")).toBe(false);
    expect(snap.sessionDeltas.get("session-1")?.pendingBytes).toBe(2);
  });
});

describe("computeRestoredSyncState", () => {
  const emptyState = {
    dirty: false,
    sessionsDirty: false,
    sessionsDirtyFiles: new Set<string>(),
    sessionPendingFiles: new Set<string>(),
    sessionDeltas: new Map<string, SessionDeltaEntry>(),
    sessionFullRetryPending: false,
  };

  it("treats dirty flags as sticky across snapshot and live", () => {
    const snapshot = snapshotSyncState({ ...emptyState, dirty: true });
    const restored = computeRestoredSyncState({ ...emptyState, dirty: false }, snapshot);
    expect(restored.dirty).toBe(true);

    const snapshot2 = snapshotSyncState({ ...emptyState, dirty: false });
    const restored2 = computeRestoredSyncState({ ...emptyState, dirty: true }, snapshot2);
    expect(restored2.dirty).toBe(true);
  });

  it("unions dirty file sets from snapshot and live", () => {
    const snapshot = snapshotSyncState({
      ...emptyState,
      sessionsDirtyFiles: new Set(["snap-1"]),
    });
    const live = {
      ...emptyState,
      sessionsDirtyFiles: new Set(["live-1"]),
    };
    const restored = computeRestoredSyncState(live, snapshot);
    expect(Array.from(restored.sessionsDirtyFiles).toSorted()).toEqual(["live-1", "snap-1"]);
    expect(restored.sessionsDirty).toBe(true);
  });

  it("propagates sessionFullRetryPending from either side", () => {
    const snapshot = snapshotSyncState({ ...emptyState, sessionFullRetryPending: true });
    const restored = computeRestoredSyncState(emptyState, snapshot);
    expect(restored.sessionFullRetryPending).toBe(true);

    const snapshot2 = snapshotSyncState(emptyState);
    const restored2 = computeRestoredSyncState(
      { ...emptyState, sessionFullRetryPending: true },
      snapshot2,
    );
    expect(restored2.sessionFullRetryPending).toBe(true);
  });
});

describe("mergeSessionDeltas", () => {
  it("keeps entries present only in one side untouched", () => {
    const base = new Map([["only-base", delta(10, 5, 2)]]);
    const live = new Map([["only-live", delta(20, 7, 3)]]);
    const merged = mergeSessionDeltas(base, live);
    expect(merged.get("only-base")).toEqual(delta(10, 5, 2));
    expect(merged.get("only-live")).toEqual(delta(20, 7, 3));
  });

  it("takes the newer lastSize and the conservative pending counters when live has advanced", () => {
    const base = new Map([["s", delta(100, 50, 10)]]);
    const live = new Map([["s", delta(200, 30, 5)]]);
    const merged = mergeSessionDeltas(base, live);
    // lastSize: take max so we do not go backwards in time.
    expect(merged.get("s")?.lastSize).toBe(200);
    // pendingBytes / messages: take min so we do not re-count work that the
    // live indexer has already folded into its tally.
    expect(merged.get("s")?.pendingBytes).toBe(30);
    expect(merged.get("s")?.pendingMessages).toBe(5);
  });

  it("does not lose the snapshot baseline when live is at zero", () => {
    // Ensures the merge never silently wipes pending work by trusting an empty
    // live side over a legitimate snapshot.
    const base = new Map([["s", delta(100, 50, 10)]]);
    const live = new Map([["s", delta(100, 0, 0)]]);
    const merged = mergeSessionDeltas(base, live);
    expect(merged.get("s")?.pendingBytes).toBe(0);
    expect(merged.get("s")?.pendingMessages).toBe(0);
  });
});

describe("restoreRetryStateAfterReindexRollback", () => {
  it("keeps the sentinel set if it was already set before the rollback", () => {
    expect(
      restoreRetryStateAfterReindexRollback({ previous: true, ranSessionFullRebuild: false }),
    ).toBe(true);
  });
  it("sets the sentinel when the failed attempt started a full session rebuild", () => {
    expect(
      restoreRetryStateAfterReindexRollback({ previous: false, ranSessionFullRebuild: true }),
    ).toBe(true);
  });
  it("leaves the sentinel cleared otherwise", () => {
    expect(
      restoreRetryStateAfterReindexRollback({ previous: false, ranSessionFullRebuild: false }),
    ).toBe(false);
  });
});
