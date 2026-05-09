import { describe, expect, it } from "vitest";
import { resolveMemorySessionSyncPlan } from "./manager-session-sync-state.js";

describe("memory session sync state", () => {
  it("tracks active paths and bulk hashes for full scans", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: [
        { agentId: "main", sessionId: "a" },
        { agentId: "main", sessionId: "b" },
      ],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(),
      existingRows: [
        { path: "sessions/a.jsonl", hash: "hash-a" },
        { path: "sessions/b.jsonl", hash: "hash-b" },
      ],
      sessionPathForTranscript: (scope) => `sessions/${scope.sessionId}.jsonl`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toEqual(new Set(["sessions/a.jsonl", "sessions/b.jsonl"]));
    expect(plan.existingRows).toEqual([
      { path: "sessions/a.jsonl", hash: "hash-a" },
      { path: "sessions/b.jsonl", hash: "hash-b" },
    ]);
    expect(plan.existingHashes).toEqual(
      new Map([
        ["sessions/a.jsonl", "hash-a"],
        ["sessions/b.jsonl", "hash-b"],
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
        { path: "sessions/targeted-first.jsonl", hash: "hash-first" },
        { path: "sessions/targeted-second.jsonl", hash: "hash-second" },
      ],
      sessionPathForTranscript: (scope) => `sessions/${scope.sessionId}.jsonl`,
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
      sessionPathForTranscript: (scope) => `sessions/${scope.sessionId}.jsonl`,
    });

    expect(plan.indexAll).toBe(false);
    expect(plan.activePaths).toEqual(new Set(["sessions/incremental.jsonl"]));
  });
});
