import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
  const ensure = (ftsEnabled = true, ftsTable?: string) =>
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled, ftsTable });
  expect(ensure().ftsAvailable).toBe(true);
  const rows = (sql: string) => db.prepare(sql).all();
  const insert = (id: string) =>
    db.exec(`
    INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('${id}.md', 'memory', 'hash', 1, 1);
    INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('${id}', '${id}.md', 'memory', 1, 1, 'hash', 'model', '${id} body', X'', 1);
  `);
  return { db, rows, ensure, insert };
}

it("keeps body FTS identity aligned through row reassignment, deletion, and rollback", () => {
  const { db, rows } = fixture();
  db.exec(`
      INSERT INTO memory_index_chunks
        (chunk_rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (84, 'kept', 'notes.md', 'memory', 2, 3, 'b', 'model', 'original body', X'', 1);
    `);
  db.exec(`
      UPDATE memory_index_chunks
      SET chunk_rowid = 103, id = 'renamed', path = 'sessions/renamed.md', source = 'sessions',
          model = 'new-model', start_line = 5, end_line = 8, text = 'replacement body'
      WHERE id = 'kept';
    `);
  const expectedRows = [
    [103, "renamed", "sessions/renamed.md", "sessions", "new-model", 5, 8, "replacement body"],
  ];
  const readBodyIndex = () =>
    rows(
      "SELECT rowid, id, path, source, model, start_line, end_line, text FROM memory_index_chunks_fts",
    ).map(Object.values);
  expect(readBodyIndex()).toEqual(expectedRows);
  const search = db.prepare(
    "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
  );
  expect(search.all("original")).toEqual([]);
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

it.each([undefined, "chunks_fts"])(
  "drops path FTS and source triggers with body FTS %s disabled",
  (ftsTable) => {
    const { rows, ensure, insert } = fixture();
    insert("before");
    ensure(false, ftsTable);
    expect(rows("SELECT name FROM sqlite_schema WHERE name = 'memory_index_paths_fts'")).toEqual(
      [],
    );
    if (!ftsTable) {
      expect(
        rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_index_chunks_fts'",
        ),
      ).toEqual([]);
    }
    insert("disabled");
    expect(ensure().ftsAvailable).toBe(true);
    expect(rows("SELECT path, source FROM memory_index_paths_fts ORDER BY path")).toEqual([
      { path: "before.md", source: "memory" },
      { path: "disabled.md", source: "memory" },
    ]);
    expect(rows("SELECT id, text FROM memory_index_chunks_fts ORDER BY id")).toEqual([
      { id: "before", text: "before body" },
      { id: "disabled", text: "disabled body" },
    ]);
  },
);
