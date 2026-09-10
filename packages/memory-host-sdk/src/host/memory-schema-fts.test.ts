// Memory FTS tests cover canonical and shipped custom index lifecycle.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ftsTableMatchesSchema,
  memoryPathFtsTriggersMatchSchema,
  MEMORY_INDEX_FTS_COLUMNS,
} from "./memory-schema-fts.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("memory index FTS lifecycle", () => {
  it.each([
    { name: "missing", definition: undefined, expected: "missing" },
    {
      name: "ordinary",
      definition: "CREATE TABLE memory_index_chunks_fts(wrong TEXT)",
      expected: "not-fts",
    },
    {
      name: "wrong",
      definition: "CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(wrong)",
      expected: "mismatched",
    },
    {
      name: "contentless",
      definition:
        "CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, content='')",
      expected: "mismatched",
    },
  ] as const)("reports a $name persisted body schema as $expected", ({ definition, expected }) => {
    const db = new DatabaseSync(":memory:");
    try {
      if (definition) {
        db.exec(definition);
      }
      expect(
        ftsTableMatchesSchema({
          db,
          tableName: "memory_index_chunks_fts",
          expectedColumns: MEMORY_INDEX_FTS_COLUMNS,
          tokenizeClause: "",
        }),
      ).toBe(expected);
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

  it("replaces drifted path FTS triggers and rebuilds partially stale rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      expect(memoryPathFtsTriggersMatchSchema(db)).toBe(true);
      const insertSource = db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
      );
      insertSource.run("before.md", "memory", "before-hash", 1, 1);

      db.exec("DROP TRIGGER memory_index_paths_fts_after_insert");
      insertSource.run("missed.md", "memory", "missed-hash", 2, 2);
      expect(memoryPathFtsTriggersMatchSchema(db)).toBe(false);
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      expect(memoryPathFtsTriggersMatchSchema(db)).toBe(true);
      expect(db.prepare("SELECT path FROM memory_index_paths_fts ORDER BY path").all()).toEqual([
        { path: "before.md" },
        { path: "missed.md" },
      ]);

      db.exec(`
        DROP TRIGGER memory_index_paths_fts_after_insert;
        CREATE TRIGGER memory_index_paths_fts_after_insert
        AFTER INSERT ON memory_index_sources BEGIN SELECT 1; END;
      `);
      insertSource.run("drifted.md", "memory", "drifted-hash", 3, 3);
      expect(memoryPathFtsTriggersMatchSchema(db)).toBe(false);
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      expect(memoryPathFtsTriggersMatchSchema(db)).toBe(true);

      insertSource.run("repaired.md", "memory", "repaired-hash", 4, 4);
      expect(
        db.prepare("SELECT path, source FROM memory_index_paths_fts ORDER BY path").all(),
      ).toEqual([
        { path: "before.md", source: "memory" },
        { path: "drifted.md", source: "memory" },
        { path: "missed.md", source: "memory" },
        { path: "repaired.md", source: "memory" },
      ]);
    } finally {
      db.close();
    }
  });
});
