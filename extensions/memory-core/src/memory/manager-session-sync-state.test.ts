import { describe, expect, it } from "vitest";
import { resolveMemorySessionSyncPlan } from "./manager-session-sync-state.js";

describe("memory session sync state", () => {
  it("tracks active source keys and bulk hashes for full scans", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [
        { agentId: "main", sessionId: "a" },
        { agentId: "main", sessionId: "b" },
      ],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(),
      existingRows: [
        { path: "transcript:main:a", hash: "hash-a" },
        { path: "transcript:main:b", hash: "hash-b" },
      ],
      sessionTranscriptKeyForScope: (scope) => `transcript:${scope.agentId}:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toEqual(new Set(["transcript:main:a", "transcript:main:b"]));
    expect(plan.existingRows).toEqual([
      { path: "transcript:main:a", hash: "hash-a" },
      { path: "transcript:main:b", hash: "hash-b" },
    ]);
    expect(plan.existingHashes).toEqual(
      new Map([
        ["transcript:main:a", "hash-a"],
        ["transcript:main:b", "hash-b"],
      ]),
    );
  });

  it("treats targeted session syncs as refresh-only and skips unrelated pruning", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [{ agentId: "main", sessionId: "targeted-first" }],
      targetSessionTranscriptKeys: new Set(["main\0targeted-first"]),
      dirtySessionTranscripts: new Set(["main\0targeted-first"]),
      existingRows: [
        { path: "transcript:main:targeted-first", hash: "hash-first" },
        { path: "transcript:main:targeted-second", hash: "hash-second" },
      ],
      sessionTranscriptKeyForScope: (scope) => `transcript:${scope.agentId}:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toBeNull();
    expect(plan.existingRows).toBeNull();
    expect(plan.existingHashes).toBeNull();
  });

  it("keeps dirty-only incremental mode when no targeted sync is requested", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [{ agentId: "main", sessionId: "incremental" }],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(["main\0incremental"]),
      existingRows: [],
      sessionTranscriptKeyForScope: (scope) => `transcript:${scope.agentId}:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(false);
    expect(plan.activePaths).toEqual(new Set(["transcript:main:incremental"]));
  });
});
