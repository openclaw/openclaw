import { describe, expect, it } from "vitest";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";

describe("memory manager session reindex gating", () => {
  it("keeps session syncing enabled for full reindexes triggered from session-start/watch", () => {
    for (const reason of ["session-start", "watch"]) {
      for (const needsFullReindex of [true, false]) {
        expect(
          shouldSyncSessionsForReindex({
            hasSessionSource: true,
            sessionsDirty: false,
            sync: { reason },
            needsFullReindex,
          }),
        ).toBe(needsFullReindex);
      }
    }
  });

  it("keeps session syncing enabled for failed full-reindex retries without dirty files", () => {
    expect(
      shouldSyncSessionsForReindex({
        hasSessionSource: true,
        sessionsDirty: true,
        sessionsFullRetryDirty: true,
        sync: { reason: "interval" },
        needsFullReindex: false,
      }),
    ).toBe(true);
    expect(
      shouldSyncSessionsForReindex({
        hasSessionSource: true,
        sessionsDirty: true,
        sync: { reason: "session-startup-catchup" },
        needsFullReindex: false,
      }),
    ).toBe(true);
  });
});
