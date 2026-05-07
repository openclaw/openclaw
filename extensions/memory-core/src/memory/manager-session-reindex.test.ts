import { describe, expect, it } from "vitest";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";

describe("shouldSyncSessionsForReindex", () => {
  const base = {
    hasSessionSource: true,
    sessionsDirty: false,
    dirtySessionFileCount: 0,
  };

  it("skips when session source is not configured", () => {
    expect(
      shouldSyncSessionsForReindex({
        ...base,
        hasSessionSource: false,
        sessionsDirty: true,
        dirtySessionFileCount: 3,
        sessionFullRetryPending: true,
      }),
    ).toBe(false);
  });

  it("forces a sync when explicit session files are requested", () => {
    expect(
      shouldSyncSessionsForReindex({
        ...base,
        sync: { sessionFiles: ["a"] },
      }),
    ).toBe(true);
  });

  it("forces a sync on explicit force", () => {
    expect(shouldSyncSessionsForReindex({ ...base, sync: { force: true } })).toBe(true);
  });

  it("forces a sync during a full reindex", () => {
    expect(shouldSyncSessionsForReindex({ ...base, needsFullReindex: true })).toBe(true);
  });

  it("forces a sync when the previous full session rebuild is still pending retry", () => {
    expect(
      shouldSyncSessionsForReindex({
        ...base,
        sessionFullRetryPending: true,
      }),
    ).toBe(true);
  });

  it("skips regular session-start and watch reasons without dirty files", () => {
    for (const reason of ["session-start", "watch"] as const) {
      expect(
        shouldSyncSessionsForReindex({
          ...base,
          sessionsDirty: true,
          sync: { reason },
        }),
      ).toBe(false);
    }
  });

  it("syncs only when both sessionsDirty and a dirty file count are present", () => {
    expect(shouldSyncSessionsForReindex({ ...base, sessionsDirty: true })).toBe(false);
    expect(shouldSyncSessionsForReindex({ ...base, dirtySessionFileCount: 1 })).toBe(false);
    expect(
      shouldSyncSessionsForReindex({
        ...base,
        sessionsDirty: true,
        dirtySessionFileCount: 1,
      }),
    ).toBe(true);
  });
});
