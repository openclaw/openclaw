// Memory FTS tests cover canonical and shipped custom index lifecycle.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("memory index FTS lifecycle", () => {
  it.each([
    { name: "canonical", ftsTable: undefined },
    { name: "custom", ftsTable: "chunks_fts" },
  ])("drops path FTS and its source triggers with $name body FTS disabled", ({ ftsTable }) => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true }).ftsAvailable,
      ).toBe(true);
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
      ).run("before.md", "memory", "before-hash", 1, 1);

      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false, ftsTable });

      expect(
        db
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE name IN ('memory_index_paths_fts', 'memory_index_paths_fts_after_insert', 'memory_index_paths_fts_after_update', 'memory_index_paths_fts_after_delete') ORDER BY type, name",
          )
          .all(),
      ).toEqual([]);
      if (!ftsTable) {
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_index_chunks_fts'",
            )
            .get(),
        ).toBeUndefined();
      }

      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
      ).run("disabled.md", "memory", "disabled-hash", 2, 2);

      expect(
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true }).ftsAvailable,
      ).toBe(true);
      expect(
        db.prepare("SELECT path, source FROM memory_index_paths_fts ORDER BY path").all(),
      ).toEqual([
        { path: "before.md", source: "memory" },
        { path: "disabled.md", source: "memory" },
      ]);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: "statement break",
      ftsTable: "ok USING fts5(text); DROP TABLE memory_index_chunks; CREATE VIRTUAL TABLE z",
    },
    { name: "schema-qualified", ftsTable: "aux.chunks_fts" },
    { name: "quoted identifier", ftsTable: '"evil"' },
  ])("rejects $name FTS table names before interpolating SQL", ({ ftsTable }) => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true }).ftsAvailable,
      ).toBe(true);
      db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("c1", "keep.md", "memory", 1, 1, "h", "m", "hello", "[]", 1);

      expect(() =>
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true, ftsTable }),
      ).toThrow(/not a safe SQL identifier/);

      expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([{ id: "c1" }]);
    } finally {
      db.close();
    }
  });

  it("rejects unsafe embedding cache table names before interpolating SQL", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() =>
        ensureMemoryIndexSchema({
          db,
          cacheEnabled: true,
          ftsEnabled: false,
          embeddingCacheTable: "cache; DROP TABLE memory_index_chunks; --",
        }),
      ).toThrow(/not a safe SQL identifier/);
    } finally {
      db.close();
    }
  });
});
