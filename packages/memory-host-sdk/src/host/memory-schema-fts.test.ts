// Memory FTS tests cover canonical and shipped custom index lifecycle.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("memory index FTS lifecycle", () => {
  it("keeps chunk and body FTS identities aligned through writes, VACUUM, and rollback", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true }).ftsAvailable,
      ).toBe(true);
      db.exec(`
        INSERT INTO memory_index_chunks
          (chunk_rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES
          (41, 'removed', 'notes.md', 'memory', 1, 1, 'a', 'model', 'discarded body', X'', 1),
          (84, 'kept', 'notes.md', 'memory', 2, 3, 'b', 'model', 'original body', X'', 1);
        DELETE FROM memory_index_chunks WHERE id = 'removed';
        VACUUM;
      `);
      expect(db.prepare("SELECT chunk_rowid, id FROM memory_index_chunks").all()).toEqual([
        { chunk_rowid: 84, id: "kept" },
      ]);
      expect(db.prepare("SELECT rowid, id FROM memory_index_chunks_fts").all()).toEqual([
        { rowid: 84, id: "kept" },
      ]);

      db.exec(`
        UPDATE memory_index_chunks
        SET chunk_rowid = 103, id = 'renamed', path = 'sessions/renamed.md', source = 'sessions',
            model = 'new-model', start_line = 5, end_line = 8, text = 'replacement body'
        WHERE id = 'kept';
      `);
      const expectedRows = [
        {
          rowid: 103,
          id: "renamed",
          path: "sessions/renamed.md",
          source: "sessions",
          model: "new-model",
          start_line: 5,
          end_line: 8,
          text: "replacement body",
        },
      ];
      const readBodyIndex = () =>
        db
          .prepare(
            "SELECT rowid, id, path, source, model, start_line, end_line, text FROM memory_index_chunks_fts",
          )
          .all();
      expect(readBodyIndex()).toEqual(expectedRows);
      const search = db.prepare(
        "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
      );
      expect(search.all("discarded OR original")).toEqual([]);
      expect(search.all("replacement")).toEqual([{ id: "renamed" }]);

      db.exec("BEGIN IMMEDIATE; DELETE FROM memory_index_chunks WHERE id = 'renamed'");
      expect(search.all("replacement")).toEqual([]);
      db.exec("ROLLBACK");
      expect(readBodyIndex()).toEqual(expectedRows);
      expect(search.all("replacement")).toEqual([{ id: "renamed" }]);

      db.exec("DELETE FROM memory_index_chunks WHERE id = 'renamed'");
      expect(readBodyIndex()).toEqual([]);
      expect(search.all("replacement")).toEqual([]);
    } finally {
      db.close();
    }
  });

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
      db.exec(`
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('before', 'before.md', 'memory', 1, 1, 'before-hash', 'model', 'before body', X'', 1);
      `);

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
      db.exec(`
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('disabled', 'disabled.md', 'memory', 1, 1, 'disabled-hash', 'model', 'disabled body', X'', 2);
      `);

      expect(
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true }).ftsAvailable,
      ).toBe(true);
      expect(
        db.prepare("SELECT path, source FROM memory_index_paths_fts ORDER BY path").all(),
      ).toEqual([
        { path: "before.md", source: "memory" },
        { path: "disabled.md", source: "memory" },
      ]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks_fts ORDER BY id").all()).toEqual([
        { id: "before", text: "before body" },
        { id: "disabled", text: "disabled body" },
      ]);
    } finally {
      db.close();
    }
  });
});
