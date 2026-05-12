import { describe, expect, it, vi } from "vitest";
import {
  clearMemorySyncedSessionTranscripts,
  runMemoryTargetedSessionSync,
} from "./manager-targeted-sync.js";

describe("memory targeted session sync", () => {
  it("preserves unrelated dirty sessions after targeted cleanup", () => {
    const firstSessionKey = "main\0targeted-dirty-first";
    const secondSessionKey = "main\0targeted-dirty-second";
    const dirtySessionTranscripts = new Set([firstSessionKey, secondSessionKey]);

    const sessionsDirty = clearMemorySyncedSessionTranscripts({
      dirtySessionTranscripts,
      targetSessionTranscriptKeys: [firstSessionKey],
    });

    expect(dirtySessionTranscripts.has(secondSessionKey)).toBe(true);
    expect(sessionsDirty).toBe(true);
  });

  it("runs a full in-place reindex after fallback activates during targeted sync", async () => {
    const activateFallbackProvider = vi.fn(async () => true);
    const runFullReindex = vi.fn(async () => {});

    await runMemoryTargetedSessionSync({
      hasSessionSource: true,
      targetSessionTranscriptKeys: new Set(["main\0targeted-fallback"]),
      reason: "post-compaction",
      progress: undefined,
      dirtySessionTranscripts: new Set(),
      syncSessionTranscripts: async () => {
        throw new Error("embedding backend failed");
      },
      shouldFallbackOnError: () => true,
      activateFallbackProvider,
      runFullReindex,
    });

    expect(activateFallbackProvider).toHaveBeenCalledWith("embedding backend failed");
    expect(runFullReindex).toHaveBeenCalledWith({
      reason: "post-compaction",
      force: true,
      progress: undefined,
    });
  });
});
