import { describe, expect, it, vi } from "vitest";

describe("skills refresh state", () => {
  it("seeds a process-local version so persisted restart snapshots refresh once", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
      vi.resetModules();
      const refreshState = await import("./refresh-state.js");

      const startupVersion = refreshState.getSkillsSnapshotVersion("/tmp/workspace");

      expect(startupVersion).toBe(Date.parse("2026-04-25T12:00:00Z"));
      expect(refreshState.shouldRefreshSnapshotForVersion(0, startupVersion)).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });
});
