import { describe, expect, it } from "vitest";
import {
  resolveMemorySessionStartupState,
  resolveMemorySessionSyncPlan,
} from "./manager-session-sync-state.js";

describe("memory session sync state", () => {
  it("tracks active paths and bulk hashes without rebuilding unchanged full scans", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: ["/tmp/a.jsonl", "/tmp/b.jsonl"],
      targetSessionFiles: null,
      existingRows: [
        { path: "sessions/a.jsonl", hash: "hash-a" },
        { path: "sessions/b.jsonl", hash: "hash-b" },
      ],
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
    });

    expect(plan.indexAll).toBe(false);
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
      files: ["/tmp/targeted-first.jsonl"],
      targetSessionFiles: new Set(["/tmp/targeted-first.jsonl"]),
      existingRows: [
        { path: "sessions/targeted-first.jsonl", hash: "hash-first" },
        { path: "sessions/targeted-second.jsonl", hash: "hash-second" },
      ],
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toBeNull();
    expect(plan.existingRows).toBeNull();
    expect(plan.existingHashes).toBeNull();
  });

  it("marks identity-targeted syncs as session work", async () => {
    const { shouldSyncSessionsForReindex } = await import("./manager-session-reindex.js");

    expect(
      shouldSyncSessionsForReindex({
        hasSessionSource: true,
        sessionsDirty: false,
        sync: { sessions: [{ agentId: "main", sessionId: "targeted" }] },
      }),
    ).toBe(true);
  });

  it("marks missing and changed startup session files dirty", () => {
    const file = (name: string, mtimeMs: number, size: number) => ({
      absPath: `/tmp/sessions/${name}.jsonl`,
      path: `sessions/${name}.jsonl`,
      mtimeMs,
      size,
    });
    const { dirtyFiles } = resolveMemorySessionStartupState({
      files: [
        file("unchanged", 100.75, 10),
        file("sub-ms-newer", 100.75, 10),
        file("invalidated", 200, 20),
        file("newer", 250, 20),
        file("rolled-back", 150, 20),
        file("resized", 300, 31),
        file("missing", 400, 40),
      ],
      existingRows: [
        { path: "sessions/unchanged.jsonl", hash: "hash-unchanged", mtime: 100.75, size: 10 },
        { path: "sessions/sub-ms-newer.jsonl", hash: "hash-sub-ms", mtime: 100.25, size: 10 },
        { path: "sessions/invalidated.jsonl", hash: "", mtime: 200, size: 20 },
        { path: "sessions/newer.jsonl", hash: "hash-newer", mtime: 200, size: 20 },
        { path: "sessions/rolled-back.jsonl", hash: "hash-rolled-back", mtime: 200, size: 20 },
        { path: "sessions/resized.jsonl", hash: "hash-resized", mtime: 300, size: 30 },
      ],
    });

    expect(dirtyFiles).toEqual([
      "/tmp/sessions/sub-ms-newer.jsonl",
      "/tmp/sessions/invalidated.jsonl",
      "/tmp/sessions/newer.jsonl",
      "/tmp/sessions/rolled-back.jsonl",
      "/tmp/sessions/resized.jsonl",
      "/tmp/sessions/missing.jsonl",
    ]);
  });

  it("detects indexed session paths that are absent from the live corpus", () => {
    expect(
      resolveMemorySessionStartupState({
        files: [],
        existingRows: [
          { path: "sessions/deleted.jsonl", hash: "hash-deleted", mtime: 100, size: 10 },
        ],
      }),
    ).toEqual({ dirtyFiles: [], hasStaleIndexedPaths: true });
  });
});
