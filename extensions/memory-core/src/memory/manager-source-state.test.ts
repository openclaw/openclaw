// Memory Core tests cover manager source state plugin behavior.
import { describe, expect, it } from "vitest";
import {
  hasMemorySourceMetadataDrift,
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";

describe("memory source state", () => {
  it.each([
    {
      name: "unchanged metadata",
      files: [{ path: "memory/one.md", mtime: 100, size: 10 }],
      rows: [{ path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 }],
      expected: false,
    },
    {
      name: "new file",
      files: [
        { path: "memory/one.md", mtime: 100, size: 10 },
        { path: "MEMORY.md", mtime: 200, size: 20 },
      ],
      rows: [{ path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 }],
      expected: true,
    },
    {
      name: "deleted file",
      files: [{ path: "memory/one.md", mtime: 100, size: 10 }],
      rows: [
        { path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 },
        { path: "memory/deleted.md", hash: "hash-2", mtime: 200, size: 20 },
      ],
      expected: true,
    },
    {
      name: "resized file",
      files: [{ path: "memory/one.md", mtime: 100, size: 11 }],
      rows: [{ path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 }],
      expected: true,
    },
    {
      name: "modified file",
      files: [{ path: "memory/one.md", mtime: 101, size: 10 }],
      rows: [{ path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 }],
      expected: true,
    },
    {
      name: "empty persisted hash",
      files: [{ path: "memory/one.md", mtime: 100, size: 10 }],
      rows: [{ path: "memory/one.md", hash: "", mtime: 100, size: 10 }],
      expected: true,
    },
    {
      name: "missing persisted mtime",
      files: [{ path: "memory/one.md", mtime: 100, size: 10 }],
      rows: [{ path: "memory/one.md", hash: "hash-1", size: 10 }],
      expected: true,
    },
    {
      name: "invalid persisted size",
      files: [{ path: "memory/one.md", mtime: 100, size: 10 }],
      rows: [{ path: "memory/one.md", hash: "hash-1", mtime: 100, size: 1.5 }],
      expected: true,
    },
    {
      name: "duplicate persisted path",
      files: [{ path: "memory/one.md", mtime: 100, size: 10 }],
      rows: [
        { path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 },
        { path: "memory/one.md", hash: "hash-2", mtime: 100, size: 10 },
      ],
      expected: true,
    },
  ])("reports $name", ({ files, rows, expected }) => {
    expect(hasMemorySourceMetadataDrift({ files, existingRows: rows })).toBe(expected);
  });

  it("loads source hashes with one bulk query", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const state = loadMemorySourceFileState({
      db: {
        prepare: (sql) => ({
          all: (...args) => {
            calls.push({ sql, args });
            return [
              { path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 },
              { path: "memory/two.md", hash: "hash-2", mtime: 200, size: 20 },
            ];
          },
          get: () => undefined,
        }),
      },
      source: "memory",
    });

    expect(calls).toEqual([
      {
        sql: "SELECT path, hash, mtime, size FROM memory_index_sources WHERE source = ?",
        args: ["memory"],
      },
    ]);
    expect(state.rows).toEqual([
      { path: "memory/one.md", hash: "hash-1", mtime: 100, size: 10 },
      { path: "memory/two.md", hash: "hash-2", mtime: 200, size: 20 },
    ]);
    expect(state.hashes).toEqual(
      new Map([
        ["memory/one.md", "hash-1"],
        ["memory/two.md", "hash-2"],
      ]),
    );
  });

  it("uses bulk snapshot hashes when present", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const hash = resolveMemorySourceExistingHash({
      db: {
        prepare: (sql) => ({
          all: () => [],
          get: (...args) => {
            calls.push({ sql, args });
            return { hash: "unexpected" };
          },
        }),
      },
      source: "sessions",
      path: "sessions/thread.jsonl",
      existingHashes: new Map([["sessions/thread.jsonl", "hash-from-snapshot"]]),
    });

    expect(hash).toBe("hash-from-snapshot");
    expect(calls).toStrictEqual([]);
  });

  it("falls back to per-file lookups without a bulk snapshot", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const hash = resolveMemorySourceExistingHash({
      db: {
        prepare: (sql) => ({
          all: () => [],
          get: (...args) => {
            calls.push({ sql, args });
            return { hash: "hash-from-row" };
          },
        }),
      },
      source: "sessions",
      path: "sessions/thread.jsonl",
      existingHashes: null,
    });

    expect(hash).toBe("hash-from-row");
    expect(calls).toEqual([
      {
        sql: "SELECT hash FROM memory_index_sources WHERE path = ? AND source = ?",
        args: ["sessions/thread.jsonl", "sessions"],
      },
    ]);
  });
});
