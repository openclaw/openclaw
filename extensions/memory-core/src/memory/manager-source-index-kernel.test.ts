import { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMemorySessionTombstones } from "../memory-session-tombstones.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const databases: MemoryIndexDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.release();
  }
});

async function createDatabase(): Promise<MemoryIndexDatabase> {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const database = new MemoryIndexDatabase(db);
  databases.push(database);
  const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
  expect(schema.ftsAvailable).toBe(true);
  const vector = await loadSqliteVecExtension({ db });
  expect(vector.ok).toBe(true);
  db.exec(
    "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3])",
  );
  database.fts.enabled = true;
  database.fts.available = true;
  database.vector.enabled = true;
  database.vector.available = true;
  return database;
}

function replacement(path: string, hash = "original"): MemorySourceIndexReplacement {
  return {
    source: "memory",
    entry: { path, hash, mtimeMs: 100.25, size: 12 },
    model: "test-model",
    now: 100,
    vectorReady: true,
    embeddings: [[1, 0, 0]],
    chunks: [
      {
        startLine: 1,
        endLine: 1,
        text: `${hash} indexed text`,
        hash,
        importance: 7,
        triggers: "indexed",
        projectKey: "project",
        provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 90 },
      },
    ],
  };
}

function write(database: MemoryIndexDatabase, value: MemorySourceIndexReplacement) {
  return runSqliteImmediateTransactionSync(database.db, () =>
    database.sourceIndex.replace(value, database.sourceIndex),
  );
}

function snapshot(db: DatabaseSync) {
  return [
    "memory_index_sources",
    "memory_index_chunks",
    "memory_index_chunk_recall_metadata",
    "memory_index_chunk_provenance",
    "memory_index_chunks_fts",
    "memory_index_paths_fts",
    "memory_index_state",
  ]
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    .concat([
      db
        .prepare("SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id")
        .all(),
    ]);
}

describe("memory source index native kernel", () => {
  it("rolls back every index representation when the final source upsert fails", async () => {
    const database = await createDatabase();
    const beforeValue = replacement("memory/current.md");
    write(database, beforeValue);
    write(database, replacement("memory/sibling.md"));
    const before = snapshot(database.db);
    database.db.exec(`CREATE TRIGGER fail_source_update
      AFTER UPDATE ON memory_index_sources
      BEGIN SELECT RAISE(FAIL, 'source upsert failed'); END`);
    expect(() => write(database, replacement(beforeValue.entry.path, "updated"))).toThrow(
      "source upsert failed",
    );
    expect(snapshot(database.db)).toEqual(before);
    database.db.exec("DROP TRIGGER fail_source_update");
    expect(write(database, replacement(beforeValue.entry.path, "updated"))).toBe("replaced");
    expect(database.db.prepare("SELECT text FROM memory_index_chunks ORDER BY path").all()).toEqual(
      [{ text: "updated indexed text" }, { text: "original indexed text" }],
    );
  });

  it("conditionally removes all source representations while retaining a sibling", async () => {
    const database = await createDatabase();
    write(database, replacement("memory/current.md"));
    write(database, replacement("memory/sibling.md"));
    const before = snapshot(database.db);
    const remove = (expectedHash: string) =>
      runSqliteImmediateTransactionSync(database.db, () =>
        database.sourceIndex.deleteIfCurrent({
          path: "memory/current.md",
          source: "memory",
          expectedHash,
        }),
      );
    expect(remove("stale")).toBe(false);
    expect(snapshot(database.db)).toEqual(before);
    expect(remove("original")).toBe(true);
    for (const table of [
      "memory_index_sources",
      "memory_index_chunks",
      "memory_index_chunks_fts",
      "memory_index_paths_fts",
    ]) {
      expect(database.db.prepare(`SELECT path FROM ${table}`).all()).toEqual([
        { path: "memory/sibling.md" },
      ]);
    }
    for (const table of [
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_index_chunks_vec",
    ]) {
      expect(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 1,
      });
    }
  });

  it("checks the canonical tombstone connection before changing a shadow index", async () => {
    const canonical = await createDatabase();
    const shadow = await createDatabase();
    const value: MemorySourceIndexReplacement = {
      ...replacement("sessions/current.jsonl"),
      source: "sessions",
      agentId: "main",
      sessionId: "session-one",
    };
    write(shadow, value);
    const before = snapshot(shadow.db);
    ensureMemorySessionTombstones(canonical.db);
    canonical.db
      .prepare("INSERT INTO memory_session_tombstones VALUES (?, ?, ?, ?)")
      .run("session-one", "main", "forgotten", 200);
    expect(
      runSqliteImmediateTransactionSync(shadow.db, () =>
        shadow.sourceIndex.replace(
          { ...value, entry: { ...value.entry, hash: "updated" } },
          canonical.sourceIndex,
        ),
      ),
    ).toBe("forgotten");
    expect(snapshot(shadow.db)).toEqual(before);
    expect(canonical.db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual(
      { count: 0 },
    );
  });
});
