import { describe, expect, it, vi } from "vitest";
import {
  markMemoryTargetArchiveFilesDirty,
  runMemoryTargetedSessionSync,
} from "./manager-targeted-sync.js";

describe("memory targeted session sync", () => {
  it("marks target sessions dirty while identity sync is paused", () => {
    const targetSessionPath = "/tmp/paused-target.jsonl";
    const sessionsDirtyFiles = new Set(["/tmp/other-dirty.jsonl"]);

    const sessionsDirty = markMemoryTargetArchiveFilesDirty({
      sessionsDirtyFiles,
      targetArchiveFiles: [targetSessionPath],
    });

    expect(sessionsDirty).toBe(true);
    expect(sessionsDirtyFiles.has(targetSessionPath)).toBe(true);
    expect(sessionsDirtyFiles.has("/tmp/other-dirty.jsonl")).toBe(true);
  });

  it("leaves targeted sessions dirty after fallback activates during targeted sync", async () => {
    const activateFallbackProvider = vi.fn(async () => true);
    const syncArchiveFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error("embedding backend failed"))
      .mockResolvedValueOnce(undefined);
    const sessionsDirtyFiles = new Set(["/tmp/targeted-fallback.jsonl", "/tmp/other-dirty.jsonl"]);

    const result = await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetArchiveFiles: new Set(["/tmp/targeted-fallback.jsonl"]),
      reason: "post-compaction",
      progress: undefined,
      sessionsDirtyFiles,
      syncArchiveFiles,
      shouldFallbackOnError: () => true,
      activateFallbackProvider,
    });

    expect(activateFallbackProvider).toHaveBeenCalledWith("embedding backend failed");
    expect(syncArchiveFiles).toHaveBeenCalledTimes(1);
    expect(syncArchiveFiles).toHaveBeenCalledWith({
      needsFullReindex: false,
      targetArchiveFiles: ["/tmp/targeted-fallback.jsonl"],
      progress: undefined,
    });
    expect(result).toEqual({
      handled: true,
      sessionsDirty: true,
      failure: { error: expect.objectContaining({ message: "embedding backend failed" }) },
    });
    expect(sessionsDirtyFiles.has("/tmp/targeted-fallback.jsonl")).toBe(true);
    expect(sessionsDirtyFiles.has("/tmp/other-dirty.jsonl")).toBe(true);
  });

  it.each([
    { marker: "full-retry", dirtyState: { sessionsFullRetryDirty: true } },
    { marker: "source reconciliation", dirtyState: { sessionsReconcileDirty: true } },
  ])("preserves the $marker dirty marker after targeted cleanup", async ({ dirtyState }) => {
    const sessionsDirtyFiles = new Set(["/tmp/targeted-cleanup.jsonl"]);
    const result = await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetArchiveFiles: new Set(sessionsDirtyFiles),
      reason: "post-compaction",
      progress: undefined,
      ...dirtyState,
      sessionsDirtyFiles,
      syncArchiveFiles: async () => undefined,
      shouldFallbackOnError: () => false,
      activateFallbackProvider: async () => false,
    });

    expect(result).toEqual({ handled: true, sessionsDirty: true });
    expect(sessionsDirtyFiles.size).toBe(0);
  });
});
