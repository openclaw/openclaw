import assert from "node:assert/strict";
import { endianness } from "node:os";
import { constants, DatabaseSync } from "node:sqlite";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemorySourceIndexKernel } from "./manager-source-index-kernel.js";
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
  it.each([0, 2048])("bounds statement preparations for %s chunks", async (chunks) => {
    const database = await createDatabase();
    const tables = [
      "memory_index_chunks",
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_index_chunks_fts",
    ];
    const prepare = vi.spyOn(database.db, "prepare");
    try {
      write(database, replacement("memory/current.md", "original", chunks));
      const prepared = prepare.mock.calls.flatMap(([sql]) => {
        const table = /^\s*INSERT INTO "?(\w+)"?\s*\(/i.exec(sql)?.[1];
        return table && tables.includes(table) ? [table] : [];
      });
      for (const table of tables) {
        expect(
          prepared.filter((value) => value === table),
          table,
        ).toHaveLength(chunks && table !== "memory_index_chunks_fts" ? 1 : 0);
      }
    } finally {
      prepare.mockRestore();
    }
  });

  it("uses native vector point lookups for sparse replacement and source deletion", async () => {
    const database = await createDatabase();
    const pathname = "memory/current.md";
    write(database, replacement(pathname, "original", 3));
    write(database, replacement("memory/sibling.md"));
    write(database, {
      ...replacement(pathname),
      source: "sessions",
      agentId: "main",
      sessionId: "sibling-session",
    });
    const siblings = database.db
      .prepare("SELECT id FROM memory_index_chunks WHERE path != ? OR source != ? ORDER BY id")
      .all(pathname, "memory");
    for (const phase of ["replace", "delete"] as const) {
      const prepare = vi.spyOn(database.db, "prepare");
      let deletes: string[];
      try {
        if (phase === "replace") {
          write(database, replacement(pathname, "updated", 3));
        } else {
          remove(database, pathname, "updated");
        }
        deletes = prepare.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => /^DELETE FROM memory_index_chunks_vec\b/.test(sql));
      } finally {
        prepare.mockRestore();
      }
      const vectorPlans = deletes.flatMap((sql) =>
        database.db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((row) => String(row.detail))
          .filter((detail) => detail.includes("memory_index_chunks_vec VIRTUAL TABLE INDEX")),
      );
      expect(vectorPlans.length).toBeGreaterThan(0);
      // sqlite-vec's native plan 2 uses the primary key; plan 1 scans every vector.
      expect(vectorPlans.every((detail) => /VIRTUAL TABLE INDEX \d+:2\b/.test(detail))).toBe(true);
      const vectors = database.db
        .prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id")
        .all();
      expect(vectors).toEqual(expect.arrayContaining(siblings));
      expect(vectors).toHaveLength(phase === "replace" ? 5 : 2);
      expect(
        database.db
          .prepare("SELECT id FROM memory_index_chunks WHERE hash = 'original' ORDER BY id")
          .all(),
      ).toEqual(siblings);
      expect(
        database.db.prepare("SELECT rowid, id FROM memory_index_chunks_fts ORDER BY rowid").all(),
      ).toEqual(
        database.db
          .prepare("SELECT chunk_rowid AS rowid, id FROM memory_index_chunks ORDER BY chunk_rowid")
          .all(),
      );
    }
  });

  it("removes a large source in one native vector delete while retaining siblings", async () => {
    const database = await createDatabase();
    const db = database.db;
    const pathname = "memory/current.md";
    write(database, replacement(pathname, "original", 2048));
    write(database, replacement("memory/sibling.md"));
    write(database, {
      ...replacement(pathname),
      source: "sessions",
      agentId: "main",
      sessionId: "sibling-session",
    });
    const siblings = db
      .prepare("SELECT id FROM memory_index_chunks WHERE path != ? OR source != ? ORDER BY id")
      .all(pathname, "memory");
    const prepare = db.prepare.bind(db);
    const deletes: Array<{ calls: () => number; restore: () => void }> = [];
    const reads: Array<{ rows: () => number[]; restore: () => void }> = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (/^DELETE FROM memory_index_chunks_vec\b/.test(sql)) {
        const run = vi.spyOn(statement, "run");
        deletes.push({ calls: () => run.mock.calls.length, restore: () => run.mockRestore() });
      }
      if (/^select "id" from "memory_index_chunks"(?:\s|$)/i.test(sql)) {
        const all = vi.spyOn(statement, "all");
        const iterate = statement.iterate.bind(statement);
        const iteration = vi.spyOn(statement, "iterate").mockImplementation((...params) => {
          const iterator = iterate(...params);
          const next = vi.spyOn(iterator, "next");
          reads.push({
            rows: () => [
              next.mock.results.filter((result) => result.type === "return" && !result.value.done)
                .length,
            ],
            restore: () => next.mockRestore(),
          });
          return iterator;
        });
        reads.push({
          rows: () =>
            all.mock.results.flatMap((result) =>
              result.type === "return" ? [result.value.length] : [],
            ),
          restore: () => {
            all.mockRestore();
            iteration.mockRestore();
          },
        });
      }
      return statement;
    });
    let deleteCalls: number;
    let selectedRows: number[];
    try {
      expect(remove(database, pathname, "original")).toBe(true);
      deleteCalls = deletes.reduce((count, statement) => count + statement.calls(), 0);
      selectedRows = reads.flatMap((statement) => statement.rows());
    } finally {
      spy.mockRestore();
      for (const statement of [...deletes, ...reads]) {
        statement.restore();
      }
    }
    expect(db.prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id").all()).toEqual(
      siblings,
    );
    expect(db.prepare("SELECT id FROM memory_index_chunks ORDER BY id").all()).toEqual(siblings);
    expect(db.prepare("SELECT id FROM memory_index_chunks_fts ORDER BY id").all()).toEqual(
      siblings,
    );
    expect(deleteCalls).toBe(1);
    expect(selectedRows).toEqual([33]);
  });

  it.each([
    { chunks: 3, failAt: 2, rollback: false },
    { chunks: 3, failAt: 3, rollback: true },
    { chunks: 2048, failAt: 2, rollback: false },
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

  it("rolls back every index representation when the final source upsert fails", async () => {
    const database = await createDatabase();
    const beforeValue = replacement("memory/current.md");
    beforeValue.chunks.push({
      startLine: 3,
      endLine: 4,
      text: "second indexed text",
      hash: "second",
      importance: 4,
      triggers: "second",
      projectKey: "second-project",
      provenance: { originClass: "agent", sessionKind: "interactive", observedAt: 95 },
    });
    beforeValue.embeddings.push([0.25, -0.5, 2]);
    const sibling = replacement("memory/sibling.md");
    const updated: MemorySourceIndexReplacement = {
      ...beforeValue,
      entry: { ...beforeValue.entry, hash: "updated", mtimeMs: 200.5, size: 24 },
      now: 200,
      chunks: beforeValue.chunks.map((chunk, index) => ({
        ...chunk,
        text: `updated indexed text ${index}`,
        hash: `updated-${index}`,
      })),
      embeddings: [
        [0.5, -0.25, 0.75],
        [-1.25, 2, 0.125],
      ],
    };
    const readRows = () =>
      database.db
        .prepare(`
        SELECT chunk.path, chunk.start_line, chunk.end_line, chunk.text, chunk.embedding,
               metadata.importance, metadata.triggers, metadata.project_key,
               provenance.origin_class, provenance.session_kind, provenance.observed_at,
               hex(vector.embedding) AS vector
        FROM memory_index_chunks AS chunk
        JOIN memory_index_chunks_vec AS vector ON vector.id = chunk.id
        JOIN memory_index_chunk_recall_metadata AS metadata ON metadata.chunk_id = chunk.id
        JOIN memory_index_chunk_provenance AS provenance ON provenance.chunk_id = chunk.id
        ORDER BY chunk.path, chunk.start_line
      `)
        .all();
    const expectedRows = (values: MemorySourceIndexReplacement[]) =>
      values.flatMap((value) =>
        value.chunks.map((chunk, index) => {
          const embedding = value.embeddings[index];
          assert.ok(embedding, "each fixture chunk must have an embedding");
          const view = new DataView(new ArrayBuffer(embedding.length * 4));
          embedding.forEach((number, offset) =>
            view.setFloat32(offset * 4, number, endianness() === "LE"),
          );
          return {
            path: value.entry.path,
            start_line: chunk.startLine,
            end_line: chunk.endLine,
            text: chunk.text,
            embedding: encodeMemoryEmbedding(embedding),
            importance: chunk.importance,
            triggers: chunk.triggers,
            project_key: chunk.projectKey,
            origin_class: chunk.provenance?.originClass,
            session_kind: chunk.provenance?.sessionKind,
            observed_at: chunk.provenance?.observedAt,
            vector: Buffer.from(view.buffer).toString("hex").toUpperCase(),
          };
        }),
      );
    write(database, beforeValue);
    write(database, sibling);
    expect(readRows()).toEqual(expectedRows([beforeValue, sibling]));
    const before = snapshot(database.db);
    database.db.exec(`CREATE TRIGGER fail_source_update
      AFTER UPDATE ON memory_index_sources
      BEGIN SELECT RAISE(FAIL, 'source upsert failed'); END`);
    expect(() => write(database, updated)).toThrow("source upsert failed");
    expect(snapshot(database.db)).toEqual(before);
    database.db.exec("DROP TRIGGER fail_source_update");
    write(database, updated);
    expect(readRows()).toEqual(expectedRows([updated, sibling]));
    expect(
      database.db
        .prepare("SELECT path, hash, mtime, size FROM memory_index_sources ORDER BY path")
        .all(),
    ).toEqual([
      { path: beforeValue.entry.path, hash: "updated", mtime: 200.5, size: 24 },
      { path: sibling.entry.path, hash: "original", mtime: 100.25, size: 12 },
    ]);
  });

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
    const { chunks: _chunks, embeddings: _embeddings, ...header } = value;
    const rows: MemorySourceIndexRow[] = [
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
    write(database, session("v1", [1, 2, 3]));
    const [first, second] = readChunks(db);

    // Line 3 was rewritten into line 4; lines 1-2 are unchanged.
    expect(writeDelta(database, { ...session("v2", [1, 2, 4]), now: 500 }, [1, 2])).toEqual({
      retainedDrift: false,
    });

    expect(readChunks(db)).toEqual([
      first,
      second,
      expect.objectContaining({ start_line: 4, text: "turn 4", updated_at: 500 }),
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

  it("removes truncated rows without rewriting retained rows", async () => {
    const database = await createDatabase();
    const db = database.db;
    write(database, session("v1", [1, 2, 3]));
    const [first, second] = readChunks(db);
    expect(writeDelta(database, session("v2", [1, 2]), [1, 2])).toEqual({ retainedDrift: false });
    expect(readChunks(db)).toEqual([first, second]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 2,
    });
  });

  it("refreshes only changed provenance on retained rows", async () => {
    const database = await createDatabase();
    const db = database.db;
    write(database, session("v1", [1, 2]));
    const before = readChunks(db);
    db.exec(`CREATE TEMP TABLE provenance_updates (chunk_id TEXT);
      CREATE TEMP TRIGGER log_provenance_update AFTER UPDATE ON main.memory_index_chunk_provenance
      BEGIN INSERT INTO provenance_updates VALUES (NEW.chunk_id); END`);
    const updates = () => db.prepare("SELECT COUNT(*) AS count FROM provenance_updates").get();

    expect(writeDelta(database, session("v2", [1, 2]), [1, 2], "untrusted")).toEqual({
      retainedDrift: false,
    });
    expect(updates()).toEqual({ count: 2 });
    expect(readChunks(db)).toEqual(before);
    expect(
      db.prepare("SELECT DISTINCT origin_class FROM memory_index_chunk_provenance").all(),
    ).toEqual([{ origin_class: "untrusted" }]);

    writeDelta(database, session("v3", [1, 2]), [1, 2], "untrusted");
    expect(updates()).toEqual({ count: 2 });
  });

  it("reports drift and writes nothing when a retained row vanished before the write lock", async () => {
    const database = await createDatabase();
    const db = database.db;
    write(database, session("v1", [1, 2]));
    // A concurrent writer removed line 2 after planning.
    db.prepare("DELETE FROM memory_index_chunks WHERE start_line = 2").run();
    const before = snapshot(db);
    expect(writeDelta(database, session("v2", [1, 2, 3]), [1, 2])).toEqual({
      retainedDrift: true,
    });
    expect(snapshot(db)).toEqual(before);
    expect(readHash(db)).toEqual({ hash: "v1" });
  });

  it("rejects retained rows staged after written rows", async () => {
    const database = await createDatabase();
    const value = session("v1", [1, 2]);
    assert.equal(value.source, "sessions");
    const { chunks, embeddings: _embeddings, ...header } = value;
    const [first, second] = chunks;
    assert.ok(first && second);
    expect(() =>
      runSqliteImmediateTransactionSync(database.db, () =>
        new MemorySourceIndexKernel(database.db, database).replaceRows({ ...header, delta: true }, [
          { chunk: first, embedding: [1, 0, 0] },
          { chunk: second, embedding: [], retained: true },
        ]),
      ),
    ).toThrow("retained rows must precede written rows");
    expect(readChunks(database.db)).toEqual([]);
    expect(readHash(database.db)).toBeUndefined();
  });
});
