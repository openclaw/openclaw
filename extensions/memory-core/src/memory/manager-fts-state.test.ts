import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { deleteMemoryFtsRows } from "./manager-fts-state.js";

describe("memory FTS state", () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("only removes rows for the active model when a provider is active", () => {
    db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE memory_index_chunks_fts (source_key TEXT, path TEXT, source TEXT, model TEXT)",
    );
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (source_key, path, source, model) VALUES (?, ?, ?, ?)",
    ).run("memory/2026-01-12.md", "memory/2026-01-12.md", "memory", "mock-embed");
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (source_key, path, source, model) VALUES (?, ?, ?, ?)",
    ).run("memory/2026-01-12.md", "memory/2026-01-12.md", "memory", "other-model");

    deleteMemoryFtsRows({
      db,
      sourceKey: "memory/2026-01-12.md",
      source: "memory",
      currentModel: "mock-embed",
    });

    const rows = db
      .prepare("SELECT model FROM memory_index_chunks_fts ORDER BY model")
      .all() as Array<{
      model: string;
    }>;
    expect(rows).toEqual([{ model: "other-model" }]);
  });

  it("removes all rows for the path in FTS-only mode", () => {
    db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE memory_index_chunks_fts (source_key TEXT, path TEXT, source TEXT, model TEXT)",
    );
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (source_key, path, source, model) VALUES (?, ?, ?, ?)",
    ).run("memory/2026-01-12.md", "memory/2026-01-12.md", "memory", "mock-embed");
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (source_key, path, source, model) VALUES (?, ?, ?, ?)",
    ).run("memory/2026-01-12.md", "memory/2026-01-12.md", "memory", "fts-only");

    deleteMemoryFtsRows({
      db,
      sourceKey: "memory/2026-01-12.md",
      source: "memory",
    });

    const count = db.prepare("SELECT COUNT(*) as c FROM memory_index_chunks_fts").get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });
});
