import assert from "node:assert/strict";
import { constants, DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  MemorySourceIndexKernel,
  memoryChunkRowId,
  readMemorySourceChunks,
} from "./manager-source-index-kernel.js";
import type {
  MemorySourceIndexReplacement,
  MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";

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

function replacement(
  path: string,
  hash = "original",
  chunkCount = 1,
): MemorySourceIndexReplacement {
  return {
    source: "memory",
    entry: { path, hash, mtimeMs: 100.25, size: 12 },
    model: "test-model",
    now: 100,
    vectorReady: true,
    embeddings: Array.from({ length: chunkCount }, () => [1, 0, 0]),
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      startLine: index + 1,
      endLine: index + 1,
      text: `${hash} indexed text`,
      hash,
      importance: 7,
      triggers: "indexed",
      projectKey: "project",
      provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 90 },
    })),
  };
}

function write(database: MemoryIndexDatabase, value: MemorySourceIndexReplacement) {
  return runSqliteImmediateTransactionSync(database.db, () =>
    new MemorySourceIndexKernel(database.db, database).replaceRows(
      value,
      value.chunks.map((chunk, index) => ({ chunk, embedding: value.embeddings[index] ?? [] })),
    ),
  );
}

function remove(database: MemoryIndexDatabase, pathname: string, expectedHash: string) {
  return runSqliteImmediateTransactionSync(database.db, () =>
    new MemorySourceIndexKernel(database.db, database).deleteIfCurrent({
      path: pathname,
      source: "memory",
      expectedHash,
    }),
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
  it("publishes 129 chunks with bounded batches instead of one insert per chunk", async () => {
    const database = await createDatabase();
    let inserts = 0;
    const statements = observeHostDataSql((sql, preparingDatabase) => {
      if (
        !preparingDatabase &&
        /^insert into ["`]?memory_index_(?:chunks|chunk_recall_metadata|chunk_provenance|chunks_vec)["`]?\s/i.test(
          sql,
        )
      ) {
        inserts++;
      }
    });
    try {
      write(database, replacement("memory/batched.md", "batch", 129));
      expect(inserts).toBeGreaterThan(0);
      expect(inserts).toBeLessThanOrEqual(8);
    } finally {
      statements.restore();
    }
    for (const table of [
      "memory_index_chunks",
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_index_chunks_vec",
      "memory_index_chunks_fts",
    ]) {
      expect(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 129,
      });
    }
  });

  it.each([
    { chunks: 3, failAt: 2, rollback: false },
    { chunks: 2048, failAt: 3, rollback: true },
  ])(
    "rolls back partial native vector deletes at $failAt of $chunks (outer rollback: $rollback)",
    async ({ chunks, failAt, rollback }) => {
      const database = await createDatabase();
      const db = database.db;
      const pathname = "memory/current.md";
      write(database, replacement(pathname, "original", chunks));
      write(database, replacement("memory/sibling.md"));
      const readVectors = () =>
        db
          .prepare(
            "SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id",
          )
          .all();
      const readDebt = () =>
        db
          .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
          .get();
      const before = readVectors();
      const previousDebt = readDebt();
      if (rollback) {
        db.exec(`CREATE TRIGGER fail_cleanup_commit BEFORE DELETE ON memory_index_chunks
        BEGIN SELECT RAISE(ABORT, 'forced outer cleanup rollback'); END`);
      }
      let nativeDeletes = 0;
      db.setAuthorizer((action, table) => {
        if (
          action === constants.SQLITE_DELETE &&
          table === "memory_index_chunks_vec_rowids" &&
          ++nativeDeletes === failAt
        ) {
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });
      try {
        const removeCurrent = () => remove(database, pathname, "original");
        if (rollback) {
          expect(removeCurrent).toThrow("forced outer cleanup rollback");
        } else {
          expect(removeCurrent()).toBe(true);
        }
      } finally {
        db.setAuthorizer(null);
      }
      expect(nativeDeletes).toBe(failAt);
      expect(db.isTransaction).toBe(false);
      expect(readVectors()).toEqual(before);
      expect(readDebt()).toEqual(rollback ? previousDebt : { value: "1" });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?")
          .get(pathname),
      ).toEqual({ count: rollback ? chunks : 0 });
      expect(db.prepare("SELECT path FROM memory_index_sources ORDER BY path").all()).toEqual(
        rollback
          ? [{ path: pathname }, { path: "memory/sibling.md" }]
          : [{ path: "memory/sibling.md" }],
      );
    },
  );

  it("conditionally removes all source representations while retaining a sibling", async () => {
    const database = await createDatabase();
    write(database, replacement("memory/current.md"));
    write(database, replacement("memory/sibling.md"));
    const before = snapshot(database.db);
    expect(remove(database, "memory/current.md", "stale")).toBe(false);
    expect(snapshot(database.db)).toEqual(before);
    expect(remove(database, "memory/current.md", "original")).toBe(true);
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
});

describe("memory source index session delta", () => {
  const pathname = "sessions/main/delta.jsonl";

  function session(hash: string, lines: number[]): MemorySourceIndexReplacement {
    const value = replacement(pathname, hash, lines.length);
    return {
      ...value,
      source: "sessions",
      agentId: "main",
      sessionId: "delta-session",
      chunks: lines.map((line) => ({
        startLine: line,
        endLine: line,
        text: `turn ${line}`,
        hash: `turn-${line}`,
        importance: 7,
        triggers: "indexed",
        projectKey: "project",
        provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 90 },
      })),
    };
  }

  // Mirrors the publication producer: retained rows precede written rows.
  function writeDelta(
    database: MemoryIndexDatabase,
    value: MemorySourceIndexReplacement,
    retainedLines: number[],
    origin: "owner" | "untrusted" = "owner",
  ) {
    assert.equal(value.source, "sessions");
    const retained = value.chunks.filter((chunk) => retainedLines.includes(chunk.startLine));
    const written = value.chunks.filter((chunk) => !retainedLines.includes(chunk.startLine));
    const desiredIds = new Set(
      value.chunks.map((chunk) =>
        memoryChunkRowId(value.source, value.entry.path, chunk, value.model),
      ),
    );
    const { chunks: _chunks, embeddings: _embeddings, ...header } = value;
    const rows: MemorySourceIndexRow[] = [
      ...readMemorySourceChunks(database.db, value.source, value.entry.path)
        .filter((row) => !desiredIds.has(row.id))
        .map((row) => ({ removedId: row.id })),
      ...retained.map((chunk) => ({
        chunk: {
          ...chunk,
          text: "",
          provenance: { originClass: origin, sessionKind: "interactive" as const, observedAt: 90 },
        },
        embedding: [],
        retained: true,
      })),
      ...written.map((chunk) => ({ chunk, embedding: [1, 0, 0] })),
    ];
    return runSqliteImmediateTransactionSync(database.db, () =>
      new MemorySourceIndexKernel(database.db, database).replaceRows(
        { ...header, delta: retained.length > 0 },
        rows,
      ),
    );
  }

  const readChunks = (db: DatabaseSync) =>
    db
      .prepare(
        "SELECT chunk_rowid, start_line, text, updated_at FROM memory_index_chunks ORDER BY start_line",
      )
      .all();
  const readHash = (db: DatabaseSync) =>
    db.prepare("SELECT hash FROM memory_index_sources WHERE path = ?").get(pathname);

  it("keeps unchanged rows, writes new rows, and removes stale rows with derived data", async () => {
    const database = await createDatabase();
    const db = database.db;
    write(database, session("v1", [1, 2, 3, 4]));
    const [first, second] = readChunks(db);

    const vectorDeletes = new Set<string>();
    const statements = observeHostDataSql((sql, preparingDatabase) => {
      if (!preparingDatabase && /^DELETE FROM memory_index_chunks_vec\b/i.test(sql)) {
        vectorDeletes.add(sql);
      }
    });
    try {
      // Two removals expose sqlite-vec's full scan for multi-value IN predicates.
      writeDelta(database, { ...session("v2", [1, 2, 5, 6]), now: 500 }, [1, 2]);
    } finally {
      statements.restore();
    }

    const pointLookup = db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM memory_index_chunks_vec WHERE id = ?")
      .all("unused")
      .map((row) => row.detail);
    expect(vectorDeletes.size).toBeGreaterThan(0);
    for (const sql of vectorDeletes) {
      expect(
        db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...Array.from(sql.matchAll(/\?/g), () => "unused"))
          .map((row) => row.detail),
      ).toEqual(pointLookup);
    }

    expect(readChunks(db)).toEqual([
      first,
      second,
      expect.objectContaining({ start_line: 5, text: "turn 5", updated_at: 500 }),
      expect.objectContaining({ start_line: 6, text: "turn 6", updated_at: 500 }),
    ]);
    expect(readHash(db)).toEqual({ hash: "v2" });
    for (const table of [
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_index_chunks_vec",
    ]) {
      const idColumn = table === "memory_index_chunks_vec" ? "id" : "chunk_id";
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual(
        db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get(),
      );
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${table} WHERE ${idColumn} NOT IN (SELECT id FROM memory_index_chunks)`,
          )
          .get(),
        table,
      ).toEqual({ count: 0 });
    }
    expect(
      db.prepare("SELECT rowid, text FROM memory_index_chunks_fts ORDER BY rowid").all(),
    ).toEqual(
      db
        .prepare("SELECT chunk_rowid AS rowid, text FROM memory_index_chunks ORDER BY chunk_rowid")
        .all(),
    );
  });

  it("refreshes retained recall metadata and provenance without changing indexed content", async () => {
    const database = await createDatabase();
    const db = database.db;
    write(database, session("v1", [1, 2]));
    const before = readChunks(db);
    db.exec(`CREATE TEMP TABLE provenance_updates (chunk_id TEXT);
      CREATE TEMP TRIGGER log_provenance_update AFTER UPDATE ON main.memory_index_chunk_provenance
      BEGIN INSERT INTO provenance_updates VALUES (NEW.chunk_id); END`);
    const updates = () => db.prepare("SELECT COUNT(*) AS count FROM provenance_updates").get();

    const changed = session("v2", [1, 2]);
    changed.chunks = changed.chunks.map((chunk) => ({
      ...chunk,
      importance: 9,
      projectKey: "changed-project",
      triggers: "changed",
    }));
    writeDelta(database, changed, [1, 2], "untrusted");
    expect(updates()).toEqual({ count: 2 });
    expect(readChunks(db)).toEqual(before);
    expect(
      db.prepare("SELECT DISTINCT origin_class FROM memory_index_chunk_provenance").all(),
    ).toEqual([{ origin_class: "untrusted" }]);
    expect(
      db
        .prepare(
          "SELECT DISTINCT importance, triggers, project_key FROM memory_index_chunk_recall_metadata",
        )
        .all(),
    ).toEqual([{ importance: 9, triggers: "changed", project_key: "changed-project" }]);

    writeDelta(
      database,
      { ...changed, entry: { ...changed.entry, hash: "v3" } },
      [1, 2],
      "untrusted",
    );
    expect(updates()).toEqual({ count: 2 });
  });
});
