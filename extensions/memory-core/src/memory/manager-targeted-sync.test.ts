import { describe, expect, it, vi } from "vitest";
import { createMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

function createTargetedSyncOwner(sessionsDirtyFiles: Set<string>) {
  return {
    sources: new Set(["sessions"]),
    sessionsDirtyFiles,
    sessionsDirty: false,
    sessionsFullRetryDirty: false,
    sessionsReconcileDirty: false,
    syncOutcomes: { recordActiveFailure: vi.fn() },
    endSyncProviderGeneration: vi.fn(),
    syncArchiveFiles: vi.fn(async () => {}),
    activateFallbackProvider: vi.fn(async (_reason: string) => false),
  };
}

describe("memory targeted session sync", () => {
  it("marks target sessions dirty while identity sync is paused", () => {
    const targetSessionPath = "/tmp/paused-target.jsonl";
    const sessionsDirtyFiles = new Set(["/tmp/other-dirty.jsonl"]);

    const sessionsDirty = MemoryManagerSyncOps.prototype["markTargetArchiveFilesDirty"].call(
      createTargetedSyncOwner(sessionsDirtyFiles),
      [targetSessionPath],
    );

    expect(sessionsDirty).toBe(true);
    expect(sessionsDirtyFiles.has(targetSessionPath)).toBe(true);
    expect(sessionsDirtyFiles.has("/tmp/other-dirty.jsonl")).toBe(true);
  });

  it("leaves targeted sessions dirty after fallback activates during targeted sync", async () => {
    const activateFallbackProvider = vi.fn(async () => true);
    const syncArchiveFiles = vi
      .fn()
      .mockRejectedValueOnce(
        createMemoryEmbeddingOperationError({
          operation: "batch",
          cause: "embedding backend failed",
        }),
      )
      .mockResolvedValueOnce(undefined);
    const sessionsDirtyFiles = new Set(["/tmp/targeted-fallback.jsonl", "/tmp/other-dirty.jsonl"]);

    const owner = {
      ...createTargetedSyncOwner(sessionsDirtyFiles),
      syncArchiveFiles,
      activateFallbackProvider,
    };
    const result = await MemoryManagerSyncOps.prototype["syncTargetedSessions"].call(
      owner,
      new Set(["/tmp/targeted-fallback.jsonl"]),
    );

    expect(activateFallbackProvider).toHaveBeenCalledWith("embedding backend failed");
    expect(syncArchiveFiles).toHaveBeenCalledTimes(1);
    expect(syncArchiveFiles).toHaveBeenCalledWith({
      needsFullReindex: false,
      targetArchiveFiles: ["/tmp/targeted-fallback.jsonl"],
      progress: undefined,
      corpusEntries: undefined,
    });
    expect(result).toBe(true);
    expect(owner.sessionsDirty).toBe(true);
    expect(owner.syncOutcomes.recordActiveFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "embedding backend failed" }),
    );
    expect(sessionsDirtyFiles.has("/tmp/targeted-fallback.jsonl")).toBe(true);
    expect(sessionsDirtyFiles.has("/tmp/other-dirty.jsonl")).toBe(true);
  });

  it.each([
    { marker: "full-retry", dirtyState: { sessionsFullRetryDirty: true } },
    { marker: "source reconciliation", dirtyState: { sessionsReconcileDirty: true } },
  ])("preserves the $marker dirty marker after targeted cleanup", async ({ dirtyState }) => {
    const sessionsDirtyFiles = new Set(["/tmp/targeted-cleanup.jsonl"]);
    const owner = { ...createTargetedSyncOwner(sessionsDirtyFiles), ...dirtyState };
    const result = await MemoryManagerSyncOps.prototype["syncTargetedSessions"].call(
      owner,
      new Set(sessionsDirtyFiles),
    );

    expect(result).toBe(true);
    expect(owner.sessionsDirty).toBe(true);
    expect(owner.syncOutcomes.recordActiveFailure).not.toHaveBeenCalled();
    expect(sessionsDirtyFiles.size).toBe(0);
  });
});
