import { describe, expect, it } from "vitest";
import { resolveMemorySessionSyncPlan } from "./manager-session-sync-state.js";

describe("memory session sync state", () => {
  it("tracks active source keys and bulk hashes for full scans", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: [
        { agentId: "main", sessionId: "a" },
        { agentId: "main", sessionId: "b" },
      ],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(),
      existingRows: [
        { path: "sessions/main/a", hash: "hash-a" },
        { path: "sessions/main/b", hash: "hash-b" },
      ],
      sessionSourceKeyForTranscript: (scope) => `sessions/${scope.agentId}/${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toEqual(new Set(["sessions/main/a", "sessions/main/b"]));
    expect(plan.existingRows).toEqual([
      { path: "sessions/main/a", hash: "hash-a" },
      { path: "sessions/main/b", hash: "hash-b" },
    ]);
    expect(plan.existingHashes).toEqual(
      new Map([
        ["sessions/main/a", "hash-a"],
        ["sessions/main/b", "hash-b"],
      ]),
    );
  });

  it("treats targeted session syncs as refresh-only and skips unrelated pruning", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: [{ agentId: "main", sessionId: "targeted-first" }],
      targetSessionTranscriptKeys: new Set(["main\0targeted-first"]),
      dirtySessionTranscripts: new Set(["main\0targeted-first"]),
      existingRows: [
        { path: "sessions/main/targeted-first", hash: "hash-first" },
        { path: "sessions/main/targeted-second", hash: "hash-second" },
      ],
      sessionSourceKeyForTranscript: (scope) => `sessions/${scope.agentId}/${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toBeNull();
    expect(plan.existingRows).toBeNull();
    expect(plan.existingHashes).toBeNull();
  });

  it("keeps dirty-only incremental mode when no targeted sync is requested", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: [{ agentId: "main", sessionId: "incremental" }],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(["main\0incremental"]),
      existingRows: [],
      sessionSourceKeyForTranscript: (scope) => `sessions/${scope.agentId}/${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(false);
    expect(plan.activePaths).toEqual(new Set(["sessions/main/incremental"]));
  });
});
