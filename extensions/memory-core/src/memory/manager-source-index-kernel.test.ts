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
  type MemorySourceIndexReplacement as Replacement,
  type MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";
import { markMemoryVectorIndexClean } from "./manager-vector-rebuild-state.js";

const readVectors = () =>
  select("chunks_vec", "id, hex(embedding) AS embedding", "ORDER BY id").all();
const readDebt = () => select("meta", "value", "WHERE key = 'memory_vector_rebuild_v1'").get();
const embeddingHex = (embedding: number[]) =>
  Buffer.from(new Float32Array(embedding).buffer).toString("hex").toUpperCase();
const queryPlan = (sql: string, params: SQLInputValue[]) =>
  conn
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
const databases: MemoryIndexDatabase[] = [];
let store: MemoryIndexDatabase;
let conn: DatabaseSync;
function select(table: string, columns: string, suffix = "") {
  return conn.prepare(`SELECT ${columns} FROM memory_index_${table} ${suffix}`);
}
const sourceTables = ["sources", "chunks", "chunks_fts", "paths_fts"];
const metadataTables = ["chunk_recall_metadata", "chunk_provenance"];
const derivedTables = [...metadataTables, "chunks_vec"];
const recallMetadata = { importance: 7, triggers: "indexed", projectKey: "project" };
function expectCounts(tables: string[], count: number) {
  for (const table of tables) {
    expect(select(table, "COUNT(*) AS n").get(), table).toEqual({ n: count });
  }
}
function expectedVectors(value: Replacement) {
  return value.chunks.map((chunk, index) => ({
    id: memoryChunkRowId(value.source, value.entry.path, chunk, value.model),
    embedding: embeddingHex(value.embeddings[index]!),
  }));
}
function interruptVectorDeletes(failAt: number) {
  let count = 0;
  conn.setAuthorizer((action, table) =>
    action === constants.SQLITE_DELETE &&
    table === "memory_index_chunks_vec_rowids" &&
    ++count === failAt
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  return () => count;
}
beforeEach(async () => {
  conn = new DatabaseSync(":memory:", { allowExtension: true });
  store = new MemoryIndexDatabase(conn);
  databases.push(store);
  const schema = ensureMemoryIndexSchema({ db: conn, cacheEnabled: false, ftsEnabled: true });
  expect(schema.ftsAvailable).toBe(true);
  expect((await loadSqliteVecExtension({ db: conn })).ok).toBe(true);
  conn.exec(
    "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3])",
  );
  Object.assign(store.fts, { enabled: true, available: true });
  Object.assign(store.vector, { enabled: true, available: true });
});

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.release();
  }
});

function replacement(path: string, hash = "original", chunkCount = 1): Replacement {
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
      ...recallMetadata,
      provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 90 },
    })),
  };
}

function write(value: Replacement) {
  return runSqliteImmediateTransactionSync(conn, () =>
    new MemorySourceIndexKernel(conn, store).replaceRows(
      value,
      value.chunks.map((chunk, index) => ({ chunk, embedding: value.embeddings[index] ?? [] })),
    ),
  );
}

function writeGroup(values: Replacement[]) {
  return runSqliteImmediateTransactionSync(conn, () =>
    new MemorySourceIndexKernel(conn, store).replaceGroup(
      values.map((value) => ({
        header: value,
        rows: value.chunks.map((chunk, index) => ({
          chunk,
          embedding: value.embeddings[index] ?? [],
        })),
      })),
    ),
  );
}

function indexedSource(chunks: number, clean = true) {
  const value = replacement("memory/current.md", "original", chunks);
  const sibling = replacement("memory/sibling.md");
  write(value);
  write(sibling);
  if (clean) {
    markMemoryVectorIndexClean(store.db);
  }
  return { value, sibling };
}

function remove(pathname: string, expectedHash: string) {
  return runSqliteImmediateTransactionSync(conn, () =>
    new MemorySourceIndexKernel(conn, store).deleteIfCurrent({
      path: pathname,
      source: "memory",
      expectedHash,
    }),
  );
}

function snapshot() {
  return [...sourceTables, ...metadataTables, "state"]
    .map((table) => select(table, "*", "ORDER BY rowid").all())
    .concat([readVectors()]);
}

describe("memory source index native kernel", () => {
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
    write(appended);
    expect(
      select("chunks_vec", "id, hex(embedding) AS embedding", "WHERE id = ?").get(changedId),
    ).toEqual({ id: changedId, embedding: embeddingHex([0, 1, 0]) });
    expect(select("chunks_vec", "id", "WHERE id = ?").get(missingId)).toEqual({ id: missingId });
    expect(select("chunks_vec", "id", "WHERE id = ?").get(emptyId)).toBeUndefined();
    write({
      ...appended,
      chunks: appended.chunks.slice(0, 2),
      embeddings: appended.embeddings.slice(0, 2),
    });
    expectCounts(["chunks", "chunks_fts", ...derivedTables], 3);
  });

  it.each([
    { staleCount: 32, append: true },
    { staleCount: 33, append: true },
    { staleCount: 2163, append: true },
    { staleCount: 2163, append: false },
  ])(
    "bounds $staleCount stale-vector deletes (append: $append)",
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
        write(next);
      } finally {
        statements.restore();
      }
      // Explicit embeddings replace their vectors before stale IDs are removed.
      expect(executions).toBe(1 + Number(append) + (staleCount <= 32 ? staleCount : 1));
      const expected = [...expectedVectors(next), ...expectedVectors(sibling)].toSorted((a, b) =>
        a.id.localeCompare(b.id),
      );
      expect(readVectors()).toEqual(expected);
      expect(select("chunks", "count(*) AS n").get()).toEqual({ n: 2 + Number(append) });
      expect(readDebt()).toEqual({ value: "clean" });
    },
  );

  it.each([5, 2164])(
    "rolls back stale-vector cleanup with rebuild debt (%i chunks)",
    async (chunks) => {
      const { value } = indexedSource(chunks);
      const vectors = select("chunks_vec", "id", "ORDER BY id").all();
      const deletes = interruptVectorDeletes(4);
      try {
        write({
          ...value,
          chunks: value.chunks.slice(0, 2),
          embeddings: value.embeddings.slice(0, 2),
        });
      } finally {
        conn.setAuthorizer(null);
      }
      expect(deletes()).toBe(4);
      expect(select("chunks_vec", "id", "ORDER BY id").all()).toEqual(vectors);
      expect(select("chunks", "count(*) AS n").get()).toEqual({ n: 3 });
      expect(readDebt()).toEqual({ value: "1" });
    },
  );

  it.each([2, 129])("keeps the last embedding for repeated IDs across %s rows", async (rows) => {
    const value = replacement("memory/current.md");
    write(value);
    markMemoryVectorIndexClean(conn);
    const chunk = value.chunks[0];
    assert.ok(chunk);
    write({
      ...value,
      chunks: Array.from({ length: rows }, () => chunk),
      embeddings: Array.from({ length: rows }, (_, index) =>
        index === rows - 1 ? [1, 0, 0] : [0, 1, 0],
      ),
    });
    expect(select("chunks_vec", "hex(embedding) AS embedding").all()).toEqual([
      { embedding: embeddingHex([1, 0, 0]) },
    ]);
  });

  it.each(["unverified", "incomplete"])(
    "repairs stale same-ID vectors in a %s index",
    async (state) => {
      const value = replacement("memory/current.md");
      write(value);
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
      write(value);
      expect(select("chunks_vec", "hex(embedding) AS embedding", "WHERE id = ?").get(id)).toEqual({
        embedding: embeddingHex([0, 1, 0]),
      });
    },
  );

  it.each([
    { clean: false, chunks: 4 },
    { clean: true, chunks: 4 },
    { clean: true, chunks: 2164 },
  ])(
    "rolls back the source and vectors (clean: $clean, chunks: $chunks)",
    async ({ clean, chunks }) => {
      const { value } = indexedSource(chunks, clean);
      const before = snapshot();
      conn.exec(
        "CREATE TRIGGER fail_source_update AFTER UPDATE ON memory_index_sources BEGIN SELECT RAISE(ABORT, 'source update failed'); END",
      );
      expect(() =>
        write({
          ...value,
          chunks: value.chunks.slice(0, 2),
          embeddings: [
            [0, 1, 0],
            [1, 0, 0],
          ],
        }),
      ).toThrow("source update failed");
      expect(snapshot()).toEqual(before);
    },
  );

  it.each([
    { chunks: [129], maxInserts: 8 },
    { chunks: [64, 65], maxInserts: 8 },
    { chunks: [1, 128, 1], maxInserts: 12 },
  ])("publishes bounded chunk batches across sources ($chunks)", async ({ chunks, maxInserts }) => {
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
      writeGroup(
        chunks.map((count, index) => replacement(`memory/batched-${index}.md`, "batch", count)),
      );

      expect(inserts).toBeGreaterThan(0);
      expect(inserts).toBeLessThanOrEqual(maxInserts);
    } finally {
      statements.restore();
    }
    expectCounts(
      ["chunks", "chunks_fts", ...derivedTables],
      chunks.reduce((sum, count) => sum + count, 0),
    );
  });

  it("coalesces small sources while preserving searchable text and source metadata", async () => {
    const values = Array.from({ length: 8 }, (_, index): Replacement => {
      const value = replacement(`memory/group-${index}.md`, `topic${index}`);
      for (const chunk of value.chunks) {
        chunk.importance = index + 1;
        chunk.triggers = `trigger-${index}`;
        chunk.projectKey = `project-${index}`;
        chunk.provenance = undefined;
      }
      return {
        ...value,
        ...(index % 2 === 0
          ? { source: "memory" as const }
          : { source: "sessions" as const, agentId: "main", sessionId: `session-${index}` }),
        model: `model-${index}`,
        now: 200 + index,
      };
    });
    let inserts = 0;
    const savepoints: string[] = [];
    const statements = observeHostDataSql((sql, preparingDatabase) => {
      if (/^SAVEPOINT\b/i.test(sql)) {
        savepoints.push(sql);
      }
      if (
        !preparingDatabase &&
        /^insert into ["`]?memory_index_(?:chunks|chunk_recall_metadata|chunk_provenance)["`]?\s/i.test(
          sql,
        )
      ) {
        inserts++;
      }
    });
    try {
      writeGroup(values);
    } finally {
      statements.restore();
    }
    expect(inserts).toBe(3);
    expect(savepoints).toEqual([]);
    expect(
      conn
        .prepare(
          `SELECT c.path, c.source, c.model, c.text, c.updated_at,
                  r.importance, r.triggers, r.project_key,
                  p.origin_class, p.session_kind, p.observed_at
           FROM memory_index_chunks c
           JOIN memory_index_chunk_recall_metadata r ON r.chunk_id = c.id
           JOIN memory_index_chunk_provenance p ON p.chunk_id = c.id
           ORDER BY c.path`,
        )
        .all(),
    ).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        path: `memory/group-${index}.md`,
        source: index % 2 === 0 ? "memory" : "sessions",
        model: `model-${index}`,
        text: `topic${index} indexed text`,
        updated_at: 200 + index,
        importance: index + 1,
        triggers: `trigger-${index}`,
        project_key: `project-${index}`,
        origin_class: "untrusted",
        session_kind: "unknown",
        observed_at: 200 + index,
      })),
    );
    expect(
      conn
        .prepare("SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
        .all("topic3"),
    ).toEqual([{ path: "memory/group-3.md" }]);
    expect(
      conn
        .prepare(
          `SELECT c.path, v.distance FROM memory_index_chunks_vec v
           JOIN memory_index_chunks c ON c.id = v.id
           WHERE v.embedding MATCH ? AND k = 8 ORDER BY c.path`,
        )
        .all(Buffer.from(new Float32Array([1, 0, 0]).buffer)),
    ).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        path: `memory/group-${index}.md`,
        distance: 0,
      })),
    );
  });

  it("keeps later replacements and retained metadata authoritative within a group", async () => {
    const source = { source: "sessions" as const, agentId: "main", sessionId: "repeated" };
    const initial = { ...replacement("sessions/repeated.jsonl"), ...source };
    write(initial);
    markMemoryVectorIndexClean(conn);
    const first = { ...replacement(initial.entry.path, "discarded"), ...source, now: 200 };
    const last = { ...replacement(initial.entry.path, "searchable"), ...source, now: 300 };
    const chunk = last.chunks[0];
    assert.ok(chunk);
    const sibling = replacement("memory/sibling.md", "sibling");
    runSqliteImmediateTransactionSync(conn, () =>
      new MemorySourceIndexKernel(conn, store).replaceGroup([
        ...[first, sibling, last].map((value) => ({
          header: value,
          rows: value.chunks.map((row) => ({ chunk: row, embedding: [0, 1, 0] })),
        })),
        {
          header: { ...last, delta: true, now: 400 },
          rows: [{ chunk: { ...chunk, text: "", importance: 9 }, embedding: [], retained: true }],
        },
      ]),
    );
    expect(
      conn
        .prepare(
          `SELECT c.text, c.updated_at, r.importance FROM memory_index_chunks c
           JOIN memory_index_chunk_recall_metadata r ON r.chunk_id = c.id
           WHERE c.path = ?`,
        )
        .all(initial.entry.path),
    ).toEqual([{ text: "searchable indexed text", updated_at: 300, importance: 9 }]);
    expect(
      conn
        .prepare("SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
        .all("discarded OR original OR searchable"),
    ).toEqual([{ path: initial.entry.path }]);
    expect(
      conn
        .prepare(
          `SELECT c.path, hex(v.embedding) AS embedding FROM memory_index_chunks_vec v
           JOIN memory_index_chunks c ON c.id = v.id ORDER BY c.path`,
        )
        .all(),
    ).toEqual(
      [sibling.entry.path, initial.entry.path].map((path) => ({
        path,
        embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer)
          .toString("hex")
          .toUpperCase(),
      })),
    );
    expect(conn.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 2,
    });
  });

  it("applies later removals to chunks published by an intermediate removal flush", async () => {
    const initial = {
      ...replacement("sessions/ordered.jsonl", "obsolete", 128),
      source: "sessions" as const,
      agentId: "main",
      sessionId: "ordered",
    };
    write(initial);
    const temporary = replacement(initial.entry.path, "temporary").chunks[0];
    const survivor = replacement(initial.entry.path, "survivor").chunks[0];
    assert.ok(temporary && survivor);
    runSqliteImmediateTransactionSync(conn, () =>
      new MemorySourceIndexKernel(conn, store).replaceRows({ ...initial, delta: true }, [
        { chunk: temporary, embedding: [1, 0, 0] },
        ...initial.chunks.map((chunk) => ({
          removedId: memoryChunkRowId(initial.source, initial.entry.path, chunk, initial.model),
        })),
        {
          removedId: memoryChunkRowId(initial.source, initial.entry.path, temporary, initial.model),
        },
        { chunk: survivor, embedding: [0, 1, 0] },
      ]),
    );
    expect(conn.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "survivor indexed text" },
    ]);
    expect(
      conn
        .prepare("SELECT text FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
        .all("temporary OR obsolete OR survivor"),
    ).toEqual([{ text: "survivor indexed text" }]);
    for (const table of [
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_index_chunks_vec",
    ]) {
      expect(conn.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 1,
      });
    }
  });

  it("rolls back grouped sources and vectors when a buffered provenance write fails", async () => {
    write(replacement("memory/first.md"));
    write(replacement("memory/last.md"));
    markMemoryVectorIndexClean(conn);
    const before = snapshot();
    conn.exec(`CREATE TRIGGER fail_group_provenance BEFORE INSERT ON memory_index_chunk_provenance
      WHEN NEW.observed_at = 999 BEGIN SELECT RAISE(ABORT, 'group provenance failed'); END`);
    const first = replacement("memory/first.md", "changed");
    const last = replacement("memory/last.md", "changed");
    last.chunks = last.chunks.map((chunk) => ({
      ...chunk,
      provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 999 },
    }));
    expect(() => writeGroup([first, last])).toThrow("group provenance failed");
    expect(snapshot()).toEqual(before);
  });

  it.each([
    { chunks: 3, failAt: 2, rollback: false },
    { chunks: 2048, failAt: 3, rollback: true },
  ])(
    "rolls back $failAt/$chunks vector deletes (outer: $rollback)",
    async ({ chunks, failAt, rollback }) => {
      const pathname = "memory/current.md";
      write(replacement(pathname, "original", chunks));
      write(replacement("memory/sibling.md"));
      const before = readVectors();
      const previousDebt = readDebt();
      if (rollback) {
        conn.exec(`CREATE TRIGGER fail_cleanup_commit BEFORE DELETE ON memory_index_chunks
        BEGIN SELECT RAISE(ABORT, 'forced outer cleanup rollback'); END`);
      }
      const nativeDeletes = interruptVectorDeletes(failAt);
      try {
        const removeCurrent = () => remove(pathname, "original");
        if (rollback) {
          expect(removeCurrent).toThrow("forced outer cleanup rollback");
        } else {
          expect(removeCurrent()).toBe(true);
        }
      } finally {
        conn.setAuthorizer(null);
      }
      expect(nativeDeletes()).toBe(failAt);
      expect(conn.isTransaction).toBe(false);
      expect(readVectors()).toEqual(before);
      expect(readDebt()).toEqual(rollback ? previousDebt : { value: "1" });
      expect(select("chunks", "COUNT(*) AS count", "WHERE path = ?").get(pathname)).toEqual({
        count: rollback ? chunks : 0,
      });
      expect(select("sources", "path", "ORDER BY path").all()).toEqual(
        rollback
          ? [{ path: pathname }, { path: "memory/sibling.md" }]
          : [{ path: "memory/sibling.md" }],
      );
    },
  );

  it("conditionally removes all source representations while retaining a sibling", async () => {
    write(replacement("memory/current.md"));
    write(replacement("memory/sibling.md"));
    const before = snapshot();
    expect(remove("memory/current.md", "stale")).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(remove("memory/current.md", "original")).toBe(true);
    for (const table of sourceTables) {
      expect(select(table, "path").all()).toEqual([{ path: "memory/sibling.md" }]);
    }
    expectCounts(derivedTables, 1);
  });

  it("aborts source removal when reading vector cleanup targets fails", () => {
    const pathname = "memory/current.md";
    write(replacement(pathname));
    const before = snapshot();
    let refused = false;
    conn.setAuthorizer((action, table, column) => {
      if (
        !refused &&
        action === constants.SQLITE_READ &&
        table === "memory_index_chunks" &&
        column === "id"
      ) {
        refused = true;
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    try {
      expect(() => remove(pathname, "original")).toThrow();
    } finally {
      conn.setAuthorizer(null);
    }
    expect(refused).toBe(true);
    expect(snapshot()).toEqual(before);
  });
});

describe("memory source index session delta", () => {
  const pathname = "sessions/main/delta.jsonl";

  function session(hash: string, lines: number[]): Replacement {
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
        ...recallMetadata,
        provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 90 },
      })),
    };
  }

  // Mirrors the publication producer: retained rows precede written rows.
  function writeDelta(
    value: Replacement,
    retainedLines: number[],
    origin: "owner" | "untrusted" = "owner",
  ) {
    assert.ok(value.source === "sessions");
    const db = conn;
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
      new MemorySourceIndexKernel(db, store).replaceRows(
        { ...header, delta: retained.length > 0 },
        rows,
      ),
    );
  }

  const readChunks = () =>
    select("chunks", "chunk_rowid, start_line, text, updated_at", "ORDER BY start_line").all();

  it.each([2, 33, 129])(
    "keeps indexed point deletes for %i session removals with derived data",
    async (removedCount) => {
      write(session("v1", [1, 2, ...Array.from({ length: removedCount }, (_, i) => i + 7)]));
      const [first, second] = readChunks();

      const vectorDeletes = new Set<string>();
      const statements = observeHostDataSql((sql, preparingDatabase) => {
        if (!preparingDatabase && /^DELETE FROM memory_index_chunks_vec\b/i.test(sql)) {
          vectorDeletes.add(sql);
        }
      });
      try {
        // Known delta IDs must use point lookups even above the whole-source scan threshold.
        writeDelta({ ...session("v2", [1, 2, 5, 6]), now: 500 }, [1, 2]);
      } finally {
        statements.restore();
      }

      const pointLookup = queryPlan("DELETE FROM memory_index_chunks_vec WHERE id = ?", ["unused"]);
      expect(vectorDeletes.size).toBeGreaterThan(0);
      for (const sql of vectorDeletes) {
        expect(
          queryPlan(
            sql,
            Array.from(sql.matchAll(/\?/g), () => "unused"),
          ),
        ).toEqual(pointLookup);
      }

      expect(readChunks()).toEqual([
        first,
        second,
        expect.objectContaining({ start_line: 5, text: "turn 5", updated_at: 500 }),
        expect.objectContaining({ start_line: 6, text: "turn 6", updated_at: 500 }),
      ]);
      expect(select("sources", "hash", "WHERE path = ?").get(pathname)).toEqual({ hash: "v2" });
      for (const table of derivedTables) {
        const idColumn = table === "chunks_vec" ? "id" : "chunk_id";
        expect(select(table, "COUNT(*) AS count").get(), table).toEqual(
          select("chunks", "COUNT(*) AS count").get(),
        );
        expect(
          select(
            table,
            "COUNT(*) AS count",
            `WHERE ${idColumn} NOT IN (SELECT id FROM memory_index_chunks)`,
          ).get(),
          table,
        ).toEqual({ count: 0 });
      }
      expect(select("chunks_fts", "rowid, text", "ORDER BY rowid").all()).toEqual(
        select("chunks", "chunk_rowid AS rowid, text", "ORDER BY chunk_rowid").all(),
      );
    },
  );

  it("refreshes retained recall metadata and provenance without changing indexed content", async () => {
    write(session("v1", [1, 2]));
    const before = readChunks();
    conn.exec(`CREATE TEMP TABLE provenance_updates (chunk_id TEXT);
      CREATE TEMP TRIGGER log_provenance_update AFTER UPDATE ON main.memory_index_chunk_provenance
      BEGIN INSERT INTO provenance_updates VALUES (NEW.chunk_id); END`);
    const updates = () => conn.prepare("SELECT COUNT(*) AS count FROM provenance_updates").get();

    const changed = session("v2", [1, 2]);
    changed.chunks = changed.chunks.map((chunk) => ({
      ...chunk,
      importance: 9,
      projectKey: "changed-project",
      triggers: "changed",
    }));
    writeDelta(changed, [1, 2], "untrusted");
    expect(updates()).toEqual({ count: 2 });
    expect(readChunks()).toEqual(before);
    expect(select("chunk_provenance", "DISTINCT origin_class").all()).toEqual([
      { origin_class: "untrusted" },
    ]);
    expect(
      select("chunk_recall_metadata", "DISTINCT importance, triggers, project_key").all(),
    ).toEqual([{ importance: 9, triggers: "changed", project_key: "changed-project" }]);

    writeDelta({ ...changed, entry: { ...changed.entry, hash: "v3" } }, [1, 2], "untrusted");
    expect(updates()).toEqual({ count: 2 });
  });
});
