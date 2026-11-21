import { describe, expect, it } from "vitest";
import { MemoryManagerSessionSyncOps } from "./manager-session-sync-ops.js";
import {
  isMemorySessionIndexable,
  resolveMemorySessionStartupState,
  resolveMemorySessionSyncPlan,
} from "./manager-session-sync-state.js";

describe("memory session indexability", () => {
  // These cases live inside a describe block: the parameterized suite never
  // executed at the file top level under the shared extension runner.
  it.each([
    ["active-memory-mvd4zk3v-d58af102", undefined, undefined, false],
    ["ordinary", "agent:main:explicit:portal-1:active-memory:0123456789ab", undefined, false],
    [undefined, undefined, "agent:main:telegram:direct:owner:active-memory:0123456789ab", false],
    ["ordinary", "agent:main:explicit:active-memory-notes", undefined, true],
    // Deleted cron-run archives keep the isolated :run: key; deleted cron-job
    // archives carry the cache-stable base key (no :run: segment). Both belong
    // to the cron session family and must stay excluded from memory indexing.
    ["cron-run-archive", undefined, "agent:main:cron:job-1:run:abc123", false],
    ["cron-base-archive", undefined, "agent:main:cron:job-1", false],
  ] as const)(
    "indexability for id=%s key=%s archive=%s",
    (sessionId, sessionKey, archived, expected) => {
      expect(
        isMemorySessionIndexable({ sessionKind: "interactive", sessionId, sessionKey }, archived),
      ).toBe(expected);
    },
  );
});

describe("memory session sync state", () => {
  const syncPlan = (targetSessionFiles: Set<string> | null = null) =>
    resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: ["/tmp/a.jsonl", "/tmp/b.jsonl"],
      targetSessionFiles,
      existingRows: [
        { path: "sessions/a.jsonl", hash: "hash-a" },
        { path: "sessions/b.jsonl", hash: "hash-b" },
      ],
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
    });

  it("tracks active paths and source state without rebuilding unchanged full scans", () => {
    expect(syncPlan()).toEqual({
      indexAll: false,
      activePaths: new Set(["sessions/a.jsonl", "sessions/b.jsonl"]),
      existingRows: [
        { path: "sessions/a.jsonl", hash: "hash-a" },
        { path: "sessions/b.jsonl", hash: "hash-b" },
      ],
    });
  });

  it("treats targeted session syncs as refresh-only and skips unrelated pruning", () => {
    expect(syncPlan(new Set(["/tmp/a.jsonl"]))).toEqual({
      indexAll: true,
      activePaths: null,
      existingRows: null,
    });
  });

  it("marks identity-targeted syncs as session work", () => {
    expect(
      MemoryManagerSessionSyncOps.prototype["shouldSyncSessions"].call(
        { sources: new Set(["sessions"]), sessionsDirty: false },
        { sessions: [{ agentId: "main", sessionId: "targeted" }] },
      ),
    ).toBe(true);
  });

  it.each([
    ["unchanged", 100.75, 10, "indexed", 100.75, 10, false],
    ["sub-ms-newer", 100.75, 10, "indexed", 100.25, 10, true],
    ["invalidated", 200, 20, "", 200, 20, true],
    ["newer", 250, 20, "indexed", 200, 20, true],
    ["rolled-back", 150, 20, "indexed", 200, 20, true],
    ["resized", 300, 31, "indexed", 300, 30, true],
    ["missing", 400, 40, undefined, 0, 0, true],
  ] as const)("startup dirty state: %s", (name, mtimeMs, size, hash, mtime, indexedSize, dirty) => {
    const path = `sessions/${name}.jsonl`;
    const absPath = `/tmp/${path}`;
    expect(
      resolveMemorySessionStartupState({
        files: [{ path, absPath, mtimeMs, size }],
        existingRows: hash === undefined ? [] : [{ path, hash, mtime, size: indexedSize }],
      }),
    ).toEqual({ dirtyFiles: dirty ? [absPath] : [], hasStaleIndexedPaths: false });
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
