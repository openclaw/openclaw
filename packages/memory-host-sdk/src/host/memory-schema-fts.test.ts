import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
  const ensure = (ftsEnabled = true, ftsTable?: string) =>
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled, ftsTable });
  expect(ensure().ftsAvailable).toBe(true);
  const rows = (sql: string) => db.prepare(sql).all();
  const insert = (id: string, time: number) => {
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run(`${id}.md`, "memory", `${id}-hash`, time, time);
    db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, 'memory', 1, 1, ?, 'model', ?, X'', ?)`).run(
      id,
      `${id}.md`,
      `${id}-hash`,
      `${id} body`,
      time,
    );
  };
  return { db, rows, ensure, insert };
}

describe("memory index FTS lifecycle", () => {
  it("keeps chunk and body FTS identities aligned through writes, VACUUM, and rollback", () => {
    const { db, rows } = fixture();
    db.exec(`
      INSERT INTO memory_index_chunks
        (chunk_rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES
        (41, 'removed', 'notes.md', 'memory', 1, 1, 'a', 'model', 'discarded body', X'', 1),
        (84, 'kept', 'notes.md', 'memory', 2, 3, 'b', 'model', 'original body', X'', 1);
      DELETE FROM memory_index_chunks WHERE id = 'removed';
      VACUUM;
    `);
    expect(rows("SELECT chunk_rowid, id FROM memory_index_chunks")).toEqual([
      { chunk_rowid: 84, id: "kept" },
    ]);
    expect(rows("SELECT rowid, id FROM memory_index_chunks_fts")).toEqual([
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
      rows(
        "SELECT rowid, id, path, source, model, start_line, end_line, text FROM memory_index_chunks_fts",
      );
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
  });

  it.each([
    { name: "canonical", ftsTable: undefined },
    { name: "custom", ftsTable: "chunks_fts" },
  ])("drops path FTS and its source triggers with $name body FTS disabled", ({ ftsTable }) => {
    const { rows, ensure, insert } = fixture();
    insert("before", 1);
    ensure(false, ftsTable);
    expect(
      rows(
        "SELECT type, name FROM sqlite_master WHERE name IN ('memory_index_paths_fts', 'memory_index_paths_fts_after_insert', 'memory_index_paths_fts_after_update', 'memory_index_paths_fts_after_delete') ORDER BY type, name",
      ),
    ).toEqual([]);
    if (!ftsTable) {
      expect(
        rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_index_chunks_fts'",
        ),
      ).toEqual([]);
    }
    insert("disabled", 2);
    expect(ensure().ftsAvailable).toBe(true);
    expect(rows("SELECT path, source FROM memory_index_paths_fts ORDER BY path")).toEqual([
      { path: "before.md", source: "memory" },
      { path: "disabled.md", source: "memory" },
    ]);
    expect(rows("SELECT id, text FROM memory_index_chunks_fts ORDER BY id")).toEqual([
      { id: "before", text: "before body" },
      { id: "disabled", text: "disabled body" },
    ]);
  });
});
