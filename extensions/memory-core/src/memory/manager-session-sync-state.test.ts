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
        { sourceKey: "session:a", path: "transcript:main:a", hash: "hash-a" },
        { sourceKey: "session:b", path: "transcript:main:b", hash: "hash-b" },
      ],
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activeSourceKeys).toEqual(new Set(["session:a", "session:b"]));
    expect(plan.existingRows).toEqual([
      { sourceKey: "session:a", path: "transcript:main:a", hash: "hash-a" },
      { sourceKey: "session:b", path: "transcript:main:b", hash: "hash-b" },
    ]);
    expect(plan.existingHashes).toEqual(
      new Map([
        ["session:a", "hash-a"],
        ["session:b", "hash-b"],
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
        {
          sourceKey: "session:targeted-first",
          path: "transcript:main:targeted-first",
          hash: "hash-first",
        },
        {
          sourceKey: "session:targeted-second",
          path: "transcript:main:targeted-second",
          hash: "hash-second",
        },
      ],
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activeSourceKeys).toBeNull();
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
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(false);
    expect(plan.activeSourceKeys).toEqual(new Set(["session:incremental"]));
  });
});
