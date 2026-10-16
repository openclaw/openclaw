import assert from "node:assert/strict";
import { constants, DatabaseSync } from "node:sqlite";
import {
  encodeMemoryEmbedding,
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
import { markMemoryVectorIndexClean } from "./manager-vector-rebuild-state.js";

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
  it("retains clean vectors without native writes, full scans, or schema probes", async () => {
    const database = await createDatabase();
    const db = database.db;
    const value = replacement("memory/current.md", "original", 3);
    write(database, value);
    write(database, replacement("memory/sibling.md"));
    markMemoryVectorIndexClean(db);
    const vectors = db
      .prepare("SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id")
      .all();
    const first = value.chunks[0];
    assert.ok(first);
    first.importance = 9;
    first.provenance = {
      originClass: "agent",
      sessionKind: "interactive",
      observedAt: 110,
    };
    const statements = observeHostDataSql();
    db.setAuthorizer((action, table) =>
      (action === constants.SQLITE_INSERT || action === constants.SQLITE_DELETE) &&
      table === "memory_index_chunks_vec_rowids"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      write(database, { ...value, now: 200 });
    } finally {
      db.setAuthorizer(null);
      statements.restore();
    }
    expect(statements.queries.filter((sql) => /sqlite_(?:schema|master)/i.test(sql))).toEqual([]);
    const lookups = statements.queries.filter((sql) =>
      /^SELECT .*FROM memory_index_chunks_vec\b/i.test(sql),
    );
    expect(lookups.length).toBeGreaterThan(0);
    for (const sql of lookups) {
      expect(
        db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all("unused")
          .map((row) => row.detail),
      ).toEqual(
        db
          .prepare("EXPLAIN QUERY PLAN SELECT id FROM memory_index_chunks_vec WHERE id = ?")
          .all("unused")
          .map((row) => row.detail),
      );
    }
    expect(
      db
        .prepare("SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id")
        .all(),
    ).toEqual(vectors);
    expect(
      db
        .prepare("SELECT importance FROM memory_index_chunk_recall_metadata WHERE chunk_id = ?")
        .get(memoryChunkRowId(value.source, value.entry.path, first, value.model)),
    ).toEqual({ importance: 9 });
    expect(
      db
        .prepare("SELECT DISTINCT updated_at FROM memory_index_chunks WHERE path = ?")
        .all(value.entry.path),
    ).toEqual([{ updated_at: 200 }]);
  });

  it("repairs changed and missing vectors, appends chunks, and removes empty and stale vectors", async () => {
    const database = await createDatabase();
    const db = database.db;
    const value = replacement("memory/current.md", "original", 4);
    write(database, value);
    write(database, replacement("memory/sibling.md"));
    markMemoryVectorIndexClean(db);
    const ids = value.chunks.map((chunk) =>
      memoryChunkRowId(value.source, value.entry.path, chunk, value.model),
    );
    const [, changedId, missingId, emptyId] = ids;
    assert.ok(changedId && missingId && emptyId);
    db.prepare("DELETE FROM memory_index_chunks_vec WHERE id = ?").run(missingId);
    const appended = replacement(value.entry.path, "original", 5);
    appended.embeddings[1] = [0, 1, 0];
    appended.embeddings[3] = [];
    write(database, appended);
    expect(
      db
        .prepare("SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec WHERE id = ?")
        .get(changedId),
    ).toEqual({
      id: changedId,
      embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer)
        .toString("hex")
        .toUpperCase(),
    });
    expect(
      db.prepare("SELECT id FROM memory_index_chunks_vec WHERE id = ?").get(missingId),
    ).toEqual({
      id: missingId,
    });
    expect(
      db.prepare("SELECT id FROM memory_index_chunks_vec WHERE id = ?").get(emptyId),
    ).toBeUndefined();
    write(database, {
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
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({
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
      const database = await createDatabase();
      const db = database.db;
      const value = replacement("memory/current.md", "original", staleCount + 1);
      write(database, value);
      const sibling = replacement("memory/sibling.md");
      write(database, sibling);
      markMemoryVectorIndexClean(db);
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
        write(database, next);
      } finally {
        statements.restore();
      }
      // The new vector writer first deletes its own ID before inserting it.
      expect(executions).toBe(Number(append) + (staleCount <= 32 ? staleCount : 1));
      const expected = [
        ...next.chunks.map((chunk, index) => ({
          id: memoryChunkRowId(next.source, next.entry.path, chunk, next.model),
          embedding: Buffer.from(new Float32Array(next.embeddings[index]!).buffer)
            .toString("hex")
            .toUpperCase(),
        })),
        {
          id: memoryChunkRowId(
            sibling.source,
            sibling.entry.path,
            sibling.chunks[0]!,
            sibling.model,
          ),
          embedding: Buffer.from(new Float32Array(sibling.embeddings[0]!).buffer)
            .toString("hex")
            .toUpperCase(),
        },
      ].toSorted((a, b) => a.id.localeCompare(b.id));
      expect(
        db
          .prepare(
            "SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id",
          )
          .all(),
      ).toEqual(expected);
      expect(db.prepare("SELECT count(*) AS n FROM memory_index_chunks").get()).toEqual({
        n: 2 + Number(append),
      });
      expect(
        db
          .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
          .get(),
      ).toEqual({ value: "clean" });
    },
  );

  it.each([5, 2164])(
    "rolls back failed stale-vector cleanup and records rebuild debt during reuse (%i chunks)",
    async (chunks) => {
      const database = await createDatabase();
      const db = database.db;
      const value = replacement("memory/current.md", "original", chunks);
      write(database, value);
      write(database, replacement("memory/sibling.md"));
      markMemoryVectorIndexClean(db);
      const vectors = db.prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id").all();
      let deletes = 0;
      db.setAuthorizer((action, table) => {
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
        write(database, {
          ...value,
          chunks: value.chunks.slice(0, 2),
          embeddings: value.embeddings.slice(0, 2),
        });
      } finally {
        db.setAuthorizer(null);
      }
      expect(deletes).toBe(2);
      expect(db.prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id").all()).toEqual(
        vectors,
      );
      expect(db.prepare("SELECT count(*) AS n FROM memory_index_chunks").get()).toEqual({ n: 3 });
      expect(
        db
          .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
          .get(),
      ).toEqual({ value: "1" });
    },
  );

  it.each([2, 129])("keeps the last embedding for repeated IDs across %s rows", async (rows) => {
    const database = await createDatabase();
    const value = replacement("memory/current.md");
    write(database, value);
    markMemoryVectorIndexClean(database.db);
    const chunk = value.chunks[0];
    assert.ok(chunk);
    write(database, {
      ...value,
      chunks: Array.from({ length: rows }, () => chunk),
      embeddings: Array.from({ length: rows }, (_, index) =>
        index === rows - 1 ? [1, 0, 0] : [0, 1, 0],
      ),
    });
    expect(
      database.db.prepare("SELECT hex(embedding) AS embedding FROM memory_index_chunks_vec").all(),
    ).toEqual([
      {
        embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer)
          .toString("hex")
          .toUpperCase(),
      },
    ]);
  });

  it.each(["unverified", "incomplete"])(
    "repairs stale same-ID vectors in a %s index",
    async (state) => {
      const database = await createDatabase();
      const value = replacement("memory/current.md");
      write(database, value);
      const chunk = value.chunks[0];
      assert.ok(chunk);
      const id = memoryChunkRowId(value.source, value.entry.path, chunk, value.model);
      value.embeddings[0] = [0, 1, 0];
      database.db
        .prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?")
        .run(encodeMemoryEmbedding([0, 1, 0]), id);
      if (state === "incomplete") {
        database.db
          .prepare(
            "INSERT INTO memory_index_meta (key,value) VALUES ('memory_vector_rebuild_v1','1')",
          )
          .run();
      }
      write(database, value);
      expect(
        database.db
          .prepare("SELECT hex(embedding) AS embedding FROM memory_index_chunks_vec WHERE id = ?")
          .get(id),
      ).toEqual({
        embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer)
          .toString("hex")
          .toUpperCase(),
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
      const database = await createDatabase();
      const value = replacement("memory/current.md", "original", chunks);
      write(database, value);
      write(database, replacement("memory/sibling.md"));
      if (clean) {
        markMemoryVectorIndexClean(database.db);
      }
      const before = snapshot(database.db);
      database.db.exec(
        "CREATE TRIGGER fail_source_update AFTER UPDATE ON memory_index_sources BEGIN SELECT RAISE(ABORT, 'source update failed'); END",
      );
      expect(() =>
        write(database, {
          ...value,
          chunks: value.chunks.slice(0, 2),
          embeddings: [
            [0, 1, 0],
            [1, 0, 0],
          ],
        }),
      ).toThrow("source update failed");
      expect(snapshot(database.db)).toEqual(before);
    },
  );

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
    assert.ok(value.source === "sessions");
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

  it.each([2, 33, 129])(
    "keeps indexed point deletes for %i session removals with derived data",
    async (removedCount) => {
      const database = await createDatabase();
      const db = database.db;
      write(
        database,
        session("v1", [1, 2, ...Array.from({ length: removedCount }, (_, i) => i + 7)]),
      );
      const [first, second] = readChunks(db);

      const vectorDeletes = new Set<string>();
      const statements = observeHostDataSql((sql, preparingDatabase) => {
        if (!preparingDatabase && /^DELETE FROM memory_index_chunks_vec\b/i.test(sql)) {
          vectorDeletes.add(sql);
        }
      });
      try {
        // Known delta IDs must use point lookups even above the whole-source scan threshold.
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
          .prepare(
            "SELECT chunk_rowid AS rowid, text FROM memory_index_chunks ORDER BY chunk_rowid",
          )
          .all(),
      );
    },
  );

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
