import { describe, expect, it } from "vitest";
import { MemoryManagerSessionSyncOps } from "./manager-session-sync-ops.js";

describe("memory manager session reindex gating", () => {
  it("keeps session syncing enabled for full reindexes triggered from session-start/watch", () => {
    for (const reason of ["session-start", "watch"]) {
      for (const needsFullReindex of [true, false]) {
        expect(
          MemoryManagerSessionSyncOps.prototype["shouldSyncSessions"].call(
            { sources: new Set(["sessions"]), sessionsDirty: false },
            { reason },
            needsFullReindex,
          ),
        ).toBe(needsFullReindex);
      }
    }
  });

  it("keeps session syncing enabled for failed full-reindex retries without dirty files", () => {
    expect(
      MemoryManagerSessionSyncOps.prototype["shouldSyncSessions"].call(
        { sources: new Set(["sessions"]), sessionsDirty: true, sessionsFullRetryDirty: true },
        { reason: "interval" },
        false,
      ),
    ).toBe(true);
    expect(
      MemoryManagerSessionSyncOps.prototype["shouldSyncSessions"].call(
        { sources: new Set(["sessions"]), sessionsDirty: true },
        { reason: "session-startup-catchup" },
        false,
      ),
    ).toBe(true);
  });
});
