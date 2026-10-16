import assert from "node:assert/strict";
import { constants, DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { markMemoryVectorIndexClean } from "./manager-vector-rebuild-state.js";

function queryAll(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).all(...params);
}
function queryOne(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).get(...params);
}

const readVectors = (db: DatabaseSync) =>
  queryAll(db, "SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id");
const readDebt = (db: DatabaseSync) =>
  queryOne(db, "SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'");
const embeddingHex = (embedding: number[]) =>
  Buffer.from(new Float32Array(embedding).buffer).toString("hex").toUpperCase();
const queryPlan = (db: DatabaseSync, sql: string, params: SQLInputValue[]) =>
  queryAll(db, `EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => row.detail);
const databases: MemoryIndexDatabase[] = [];
let store: MemoryIndexDatabase;
let conn: DatabaseSync;
beforeEach(async () => {
  store = await createDatabase();
  conn = store.db;
});

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

function indexedSource(chunks: number, clean = true) {
  const value = replacement("memory/current.md", "original", chunks);
  const sibling = replacement("memory/sibling.md");
  write(store, value);
  write(store, sibling);
  if (clean) {
    markMemoryVectorIndexClean(store.db);
  }
  return { value, sibling };
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
    .map((table) => queryAll(db, `SELECT * FROM ${table} ORDER BY rowid`))
    .concat([readVectors(db)]);
}

describe("memory source index native kernel", () => {
  it("retains clean vectors without native writes, full scans, or schema probes", async () => {
    const { value } = indexedSource(3);
    const vectors = readVectors(conn);
    const first = value.chunks[0];
    assert.ok(first);
    first.importance = 9;
    first.provenance = {
      originClass: "agent",
      sessionKind: "interactive",
      observedAt: 110,
    };
    const statements = observeHostDataSql();
    conn.setAuthorizer((action, table) =>
      (action === constants.SQLITE_INSERT || action === constants.SQLITE_DELETE) &&
      table === "memory_index_chunks_vec_rowids"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      write(store, { ...value, now: 200 });
    } finally {
      conn.setAuthorizer(null);
      statements.restore();
    }
    expect(statements.queries.filter((sql) => /sqlite_(?:schema|master)/i.test(sql))).toEqual([]);
    const lookups = statements.queries.filter((sql) =>
      /^SELECT .*FROM memory_index_chunks_vec\b/i.test(sql),
    );
    expect(lookups.length).toBeGreaterThan(0);
    for (const sql of lookups) {
      expect(queryPlan(conn, sql, ["unused"])).toEqual(
        queryPlan(conn, "SELECT id FROM memory_index_chunks_vec WHERE id = ?", ["unused"]),
      );
    }
    expect(readVectors(conn)).toEqual(vectors);
    expect(
      conn
        .prepare("SELECT importance FROM memory_index_chunk_recall_metadata WHERE chunk_id = ?")
        .get(memoryChunkRowId(value.source, value.entry.path, first, value.model)),
    ).toEqual({ importance: 9 });
    expect(
      queryAll(
        conn,
        "SELECT DISTINCT updated_at FROM memory_index_chunks WHERE path = ?",
        value.entry.path,
      ),
    ).toEqual([{ updated_at: 200 }]);
  });

  it("repairs changed and missing vectors, appends chunks, and removes empty and stale vectors", async () => {
    const { value } = indexedSource(4);
    const ids = value.chunks.map((chunk) =>
      memoryChunkRowId(value.source, value.entry.path, chunk, value.model),
    );
    const [, changedId, missingId, emptyId] = ids;
    assert.ok(changedId && missingId && emptyId);
    conn.prepare("DELETE FROM memory_index_chunks_vec WHERE id = ?").run(missingId);
    const appended = replacement(value.entry.path, "original", 5);
    appended.embeddings[1] = [0, 1, 0];
    appended.embeddings[3] = [];
    write(store, appended);
    expect(
      queryOne(
        conn,
        "SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec WHERE id = ?",
        changedId,
      ),
    ).toEqual({
      id: changedId,
      embedding: embeddingHex([0, 1, 0]),
    });
    expect(
      queryOne(conn, "SELECT id FROM memory_index_chunks_vec WHERE id = ?", missingId),
    ).toEqual({
      id: missingId,
    });
    expect(
      queryOne(conn, "SELECT id FROM memory_index_chunks_vec WHERE id = ?", emptyId),
    ).toBeUndefined();
    write(store, {
      ...appended,
      chunks: appended.chunks.slice(0, 2),
      embeddings: appended.embeddings.slice(0, 2),
    });
    for (const table of [
      "memory_index_chunks",
      "memory_index_chunks_vec",
      "memory_index_chunks_fts",
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
    ]) {
      expect(queryOne(conn, `SELECT COUNT(*) AS count FROM ${table}`), table).toEqual({
        count: 3,
      });
    }
  });

  it.each([
    { staleCount: 32, append: true },
    { staleCount: 33, append: true },
    { staleCount: 2163, append: true },
    { staleCount: 2163, append: false },
  ])(
    "bounds complete-replacement cleanup of $staleCount stale vectors and preserves surviving vectors (append: $append)",
    async ({ staleCount, append }) => {
      const { value, sibling } = indexedSource(staleCount + 1);
      const appended = replacement(value.entry.path, "new");
      const next = {
        ...value,
        chunks: [value.chunks[0]!, ...(append ? [appended.chunks[0]!] : [])],
        embeddings: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      };
      let executions = 0;
      const statements = observeHostDataSql((sql, preparingDatabase) => {
        if (!preparingDatabase && /^DELETE FROM memory_index_chunks_vec\b/i.test(sql)) {
          executions++;
        }
      });
      try {
        write(store, next);
      } finally {
        statements.restore();
      }
      // The new vector writer first deletes its own ID before inserting it.
      expect(executions).toBe(Number(append) + (staleCount <= 32 ? staleCount : 1));
      const expected = [
        ...next.chunks.map((chunk, index) => ({
          id: memoryChunkRowId(next.source, next.entry.path, chunk, next.model),
          embedding: embeddingHex(next.embeddings[index]!),
        })),
        {
          id: memoryChunkRowId(
            sibling.source,
            sibling.entry.path,
            sibling.chunks[0]!,
            sibling.model,
          ),
          embedding: embeddingHex(sibling.embeddings[0]!),
        },
      ].toSorted((a, b) => a.id.localeCompare(b.id));
      expect(readVectors(conn)).toEqual(expected);
      expect(queryOne(conn, "SELECT count(*) AS n FROM memory_index_chunks")).toEqual({
        n: 2 + Number(append),
      });
      expect(readDebt(conn)).toEqual({ value: "clean" });
    },
  );

  it.each([5, 2164])(
    "rolls back failed stale-vector cleanup and records rebuild debt during reuse (%i chunks)",
    async (chunks) => {
      const { value } = indexedSource(chunks);
      const vectors = queryAll(conn, "SELECT id FROM memory_index_chunks_vec ORDER BY id");
      let deletes = 0;
      conn.setAuthorizer((action, table) => {
        if (
          action === constants.SQLITE_DELETE &&
          table === "memory_index_chunks_vec_rowids" &&
          ++deletes === 2
        ) {
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });
      try {
        write(store, {
          ...value,
          chunks: value.chunks.slice(0, 2),
          embeddings: value.embeddings.slice(0, 2),
        });
      } finally {
        conn.setAuthorizer(null);
      }
      expect(deletes).toBe(2);
      expect(queryAll(conn, "SELECT id FROM memory_index_chunks_vec ORDER BY id")).toEqual(vectors);
      expect(queryOne(conn, "SELECT count(*) AS n FROM memory_index_chunks")).toEqual({
        n: 3,
      });
      expect(readDebt(conn)).toEqual({ value: "1" });
    },
  );

  it.each([2, 129])("keeps the last embedding for repeated IDs across %s rows", async (rows) => {
    const value = replacement("memory/current.md");
    write(store, value);
    markMemoryVectorIndexClean(conn);
    const chunk = value.chunks[0];
    assert.ok(chunk);
    write(store, {
      ...value,
      chunks: Array.from({ length: rows }, () => chunk),
      embeddings: Array.from({ length: rows }, (_, index) =>
        index === rows - 1 ? [1, 0, 0] : [0, 1, 0],
      ),
    });
    expect(
      queryAll(conn, "SELECT hex(embedding) AS embedding FROM memory_index_chunks_vec"),
    ).toEqual([
      {
        embedding: embeddingHex([1, 0, 0]),
      },
    ]);
  });

  it.each(["unverified", "incomplete"])(
    "repairs stale same-ID vectors in a %s index",
    async (state) => {
      const value = replacement("memory/current.md");
      write(store, value);
      const chunk = value.chunks[0];
      assert.ok(chunk);
      const id = memoryChunkRowId(value.source, value.entry.path, chunk, value.model);
      value.embeddings[0] = [0, 1, 0];
      conn
        .prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?")
        .run(encodeMemoryEmbedding([0, 1, 0]), id);
      if (state === "incomplete") {
        conn
          .prepare(
            "INSERT INTO memory_index_meta (key,value) VALUES ('memory_vector_rebuild_v1','1')",
          )
          .run();
      }
      write(store, value);
      expect(
        queryOne(
          conn,
          "SELECT hex(embedding) AS embedding FROM memory_index_chunks_vec WHERE id = ?",
          id,
        ),
      ).toEqual({
        embedding: embeddingHex([0, 1, 0]),
      });
    },
  );

  it.each([
    { clean: false, chunks: 4 },
    { clean: true, chunks: 4 },
    { clean: true, chunks: 2164 },
  ])(
    "rolls back changed vectors and stale cleanup with the source update (clean: $clean, chunks: $chunks)",
    async ({ clean, chunks }) => {
      const { value } = indexedSource(chunks, clean);
      const before = snapshot(conn);
      conn.exec(
        "CREATE TRIGGER fail_source_update AFTER UPDATE ON memory_index_sources BEGIN SELECT RAISE(ABORT, 'source update failed'); END",
      );
      expect(() =>
        write(store, {
          ...value,
          chunks: value.chunks.slice(0, 2),
          embeddings: [
            [0, 1, 0],
            [1, 0, 0],
          ],
        }),
      ).toThrow("source update failed");
      expect(snapshot(conn)).toEqual(before);
    },
  );

  it("publishes 129 chunks with bounded batches instead of one insert per chunk", async () => {
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
      write(store, replacement("memory/batched.md", "batch", 129));
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
      expect(queryOne(conn, `SELECT COUNT(*) AS count FROM ${table}`)).toEqual({
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
      const pathname = "memory/current.md";
      write(store, replacement(pathname, "original", chunks));
      write(store, replacement("memory/sibling.md"));
      const before = readVectors(conn);
      const previousDebt = readDebt(conn);
      if (rollback) {
        conn.exec(`CREATE TRIGGER fail_cleanup_commit BEFORE DELETE ON memory_index_chunks
        BEGIN SELECT RAISE(ABORT, 'forced outer cleanup rollback'); END`);
      }
      let nativeDeletes = 0;
      conn.setAuthorizer((action, table) => {
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
        const removeCurrent = () => remove(store, pathname, "original");
        if (rollback) {
          expect(removeCurrent).toThrow("forced outer cleanup rollback");
        } else {
          expect(removeCurrent()).toBe(true);
        }
      } finally {
        conn.setAuthorizer(null);
      }
      expect(nativeDeletes).toBe(failAt);
      expect(conn.isTransaction).toBe(false);
      expect(readVectors(conn)).toEqual(before);
      expect(readDebt(conn)).toEqual(rollback ? previousDebt : { value: "1" });
      expect(
        queryOne(
          conn,
          "SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?",
          pathname,
        ),
      ).toEqual({ count: rollback ? chunks : 0 });
      expect(queryAll(conn, "SELECT path FROM memory_index_sources ORDER BY path")).toEqual(
        rollback
          ? [{ path: pathname }, { path: "memory/sibling.md" }]
          : [{ path: "memory/sibling.md" }],
      );
    },
  );

  it("conditionally removes all source representations while retaining a sibling", async () => {
    write(store, replacement("memory/current.md"));
    write(store, replacement("memory/sibling.md"));
    const before = snapshot(conn);
    expect(remove(store, "memory/current.md", "stale")).toBe(false);
    expect(snapshot(conn)).toEqual(before);
    expect(remove(store, "memory/current.md", "original")).toBe(true);
    for (const table of [
      "memory_index_sources",
      "memory_index_chunks",
      "memory_index_chunks_fts",
      "memory_index_paths_fts",
    ]) {
      expect(queryAll(conn, `SELECT path FROM ${table}`)).toEqual([{ path: "memory/sibling.md" }]);
    }
    for (const table of [
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_index_chunks_vec",
    ]) {
      expect(queryOne(conn, `SELECT COUNT(*) AS count FROM ${table}`)).toEqual({
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
    assert.ok(value.source === "sessions");
    const db = database.db;
    const retained = value.chunks.filter((chunk) => retainedLines.includes(chunk.startLine));
    const written = value.chunks.filter((chunk) => !retainedLines.includes(chunk.startLine));
    const desiredIds = new Set(
      value.chunks.map((chunk) =>
        memoryChunkRowId(value.source, value.entry.path, chunk, value.model),
      ),
    );
    const { chunks: _chunks, embeddings: _embeddings, ...header } = value;
    const rows: MemorySourceIndexRow[] = [
      ...readMemorySourceChunks(db, value.source, value.entry.path)
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
    return runSqliteImmediateTransactionSync(db, () =>
      new MemorySourceIndexKernel(db, database).replaceRows(
        { ...header, delta: retained.length > 0 },
        rows,
      ),
    );
  }

  const readChunks = (db: DatabaseSync) =>
    queryAll(
      db,
      "SELECT chunk_rowid, start_line, text, updated_at FROM memory_index_chunks ORDER BY start_line",
    );
  const readHash = (db: DatabaseSync) =>
    queryOne(db, "SELECT hash FROM memory_index_sources WHERE path = ?", pathname);

  it.each([2, 33, 129])(
    "keeps indexed point deletes for %i session removals with derived data",
    async (removedCount) => {
      write(store, session("v1", [1, 2, ...Array.from({ length: removedCount }, (_, i) => i + 7)]));
      const [first, second] = readChunks(conn);

      const vectorDeletes = new Set<string>();
      const statements = observeHostDataSql((sql, preparingDatabase) => {
        if (!preparingDatabase && /^DELETE FROM memory_index_chunks_vec\b/i.test(sql)) {
          vectorDeletes.add(sql);
        }
      });
      try {
        // Known delta IDs must use point lookups even above the whole-source scan threshold.
        writeDelta(store, { ...session("v2", [1, 2, 5, 6]), now: 500 }, [1, 2]);
      } finally {
        statements.restore();
      }

      const pointLookup = queryPlan(conn, "DELETE FROM memory_index_chunks_vec WHERE id = ?", [
        "unused",
      ]);
      expect(vectorDeletes.size).toBeGreaterThan(0);
      for (const sql of vectorDeletes) {
        expect(
          queryPlan(
            conn,
            sql,
            Array.from(sql.matchAll(/\?/g), () => "unused"),
          ),
        ).toEqual(pointLookup);
      }

      expect(readChunks(conn)).toEqual([
        first,
        second,
        expect.objectContaining({ start_line: 5, text: "turn 5", updated_at: 500 }),
        expect.objectContaining({ start_line: 6, text: "turn 6", updated_at: 500 }),
      ]);
      expect(readHash(conn)).toEqual({ hash: "v2" });
      for (const table of [
        "memory_index_chunk_recall_metadata",
        "memory_index_chunk_provenance",
        "memory_index_chunks_vec",
      ]) {
        const idColumn = table === "memory_index_chunks_vec" ? "id" : "chunk_id";
        expect(queryOne(conn, `SELECT COUNT(*) AS count FROM ${table}`), table).toEqual(
          queryOne(conn, "SELECT COUNT(*) AS count FROM memory_index_chunks"),
        );
        expect(
          queryOne(
            conn,
            `SELECT COUNT(*) AS count FROM ${table} WHERE ${idColumn} NOT IN (SELECT id FROM memory_index_chunks)`,
          ),
          table,
        ).toEqual({ count: 0 });
      }
      expect(
        queryAll(conn, "SELECT rowid, text FROM memory_index_chunks_fts ORDER BY rowid"),
      ).toEqual(
        queryAll(
          conn,
          "SELECT chunk_rowid AS rowid, text FROM memory_index_chunks ORDER BY chunk_rowid",
        ),
      );
    },
  );

  it("refreshes retained recall metadata and provenance without changing indexed content", async () => {
    write(store, session("v1", [1, 2]));
    const before = readChunks(conn);
    conn.exec(`CREATE TEMP TABLE provenance_updates (chunk_id TEXT);
      CREATE TEMP TRIGGER log_provenance_update AFTER UPDATE ON main.memory_index_chunk_provenance
      BEGIN INSERT INTO provenance_updates VALUES (NEW.chunk_id); END`);
    const updates = () => queryOne(conn, "SELECT COUNT(*) AS count FROM provenance_updates");

    const changed = session("v2", [1, 2]);
    changed.chunks = changed.chunks.map((chunk) => ({
      ...chunk,
      importance: 9,
      projectKey: "changed-project",
      triggers: "changed",
    }));
    writeDelta(store, changed, [1, 2], "untrusted");
    expect(updates()).toEqual({ count: 2 });
    expect(readChunks(conn)).toEqual(before);
    expect(
      queryAll(conn, "SELECT DISTINCT origin_class FROM memory_index_chunk_provenance"),
    ).toEqual([{ origin_class: "untrusted" }]);
    expect(
      queryAll(
        conn,
        "SELECT DISTINCT importance, triggers, project_key FROM memory_index_chunk_recall_metadata",
      ),
    ).toEqual([{ importance: 9, triggers: "changed", project_key: "changed-project" }]);

    writeDelta(store, { ...changed, entry: { ...changed.entry, hash: "v3" } }, [1, 2], "untrusted");
    expect(updates()).toEqual({ count: 2 });
  });
});
