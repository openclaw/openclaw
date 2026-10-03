import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVectorKnnQuery } from "./manager-search-knn.js";
import { searchChunksByEmbedding, searchVector } from "./manager-search-vector.js";
import { runMemorySearchWithDeadline } from "./search-deadline.js";
import { vectorToBlob } from "./vector-blob.js";

type VectorSearchOptions = Omit<Parameters<typeof searchVector>[0], "runFallback"> & {
  sourceFilterChunks: Parameters<typeof searchChunksByEmbedding>[0]["sourceFilter"];
};

function searchVectorFixture(db: DatabaseSync, options: Partial<VectorSearchOptions> = {}) {
  const { sourceFilterChunks = { sql: "", params: [] }, ...overrides } = options;
  const request: Omit<Parameters<typeof searchVector>[0], "runFallback"> = {
    vectorTable: "memory_index_chunks_vec",
    providerModel: "target-model",
    queryVec: [1, 0],
    limit: 5,
    snippetMaxChars: 200,
    ensureVectorReady: async () => false,
    runVectorKnn: async (knnRequest) => runVectorKnnQuery(db, knnRequest),
    sourceFilterVec: { sql: "", params: [] },
    ...overrides,
  };
  return searchVector({
    ...request,
    runFallback: () =>
      searchChunksByEmbedding({
        db,
        providerModel: request.providerModel,
        providerModelAliases: request.providerModelAliases,
        sourceFilter: sourceFilterChunks,
        queryVec: request.queryVec,
        limit: request.limit,
        snippetMaxChars: request.snippetMaxChars,
        signal: request.signal,
      }),
  });
}

describe("searchVector sqlite-vec KNN", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
  });
  function createDb() {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    databases.push(db);
    return db;
  }

  it("stops fallback scanning when the caller aborts and keeps later searches healthy", async () => {
    const db = createFallbackDb();
    for (let index = 0; index < 4096; index += 1) {
      insertFallbackChunk(db, {
        id: `chunk-${index}`,
        model: "target-model",
        vector: index === 4095 ? [1, 0] : [0, 1],
      });
    }

    let scannedRows = 0;
    db.function("observe_embedding", (embedding) => {
      scannedRows += 1;
      return embedding;
    });
    db.exec(`
        ALTER TABLE memory_index_chunks RENAME TO observed_chunks;
        CREATE VIEW memory_index_chunks AS
          SELECT chunk_rowid AS rowid, id, path, source, start_line, end_line, model, text,
                 observe_embedding(embedding) AS embedding
          FROM observed_chunks;
      `);
    const caller = new AbortController();
    const abortReason = new Error("caller stopped memory search");
    const pending = runMemorySearchWithDeadline({
      timeoutMs: 5_000,
      parentSignal: caller.signal,
      run: async (signal) => await searchVectorFixture(db, { signal }),
    });
    setImmediate(() => caller.abort(abortReason));

    await expect(pending).rejects.toBe(abortReason);
    const rowsAtAbort = scannedRows;
    expect(rowsAtAbort).toBeGreaterThan(0);
    expect(rowsAtAbort).toBeLessThan(4096);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(scannedRows).toBe(rowsAtAbort);

    const healthyResults = await searchVectorFixture(db, { limit: 1 });
    expect(healthyResults.map((result) => result.id)).toEqual(["chunk-4095"]);
  });

  function createFallbackDb(): InstanceType<typeof DatabaseSync> {
    const db = createDb();
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
    });
    return db;
  }

  function insertFallbackChunk(
    db: InstanceType<typeof DatabaseSync>,
    params: {
      id: string;
      model: string;
      vector: number[];
      source?: "memory" | "sessions";
    },
  ): void {
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      params.id,
      `memory/${params.id}.md`,
      params.source ?? "memory",
      1,
      1,
      params.id,
      params.model,
      `chunk ${params.id}`,
      encodeMemoryEmbedding(params.vector),
      1,
    );
  }

  it("picks up rows inserted during the inter-batch event-loop yield (rowid cursor)", async () => {
    // Regression #81172: a synchronous scan cannot observe these scheduled inserts.
    const db = createFallbackDb();
    // 257 baseline rows: first batch sees 256 (score 0 vs. query), second
    // batch would have seen just 1 until our setImmediate insert lands.
    const baselineCount = 257;
    for (let i = 0; i < baselineCount; i += 1) {
      insertFallbackChunk(db, {
        id: `baseline-${i}`,
        model: "target-model",
        // Perpendicular to the query: cosine 0.
        vector: [0, 1],
      });
    }

    // Insert winners after the first batch so the next cursor read must see them.
    let inserted = false;
    setImmediate(() => {
      inserted = true;
      insertFallbackChunk(db, {
        id: "winner-A",
        model: "target-model",
        vector: [1, 0],
      });
      insertFallbackChunk(db, {
        id: "winner-B",
        model: "target-model",
        vector: [0.9, 0.1],
      });
    });

    const results = await searchVectorFixture(db, { limit: 2 });

    expect(inserted).toBe(true);
    expect(results.map((r) => r.id)).toEqual(["winner-A", "winner-B"]);
  });

  it.each([
    { encoding: "UTF-8", mode: "KNN" },
    { encoding: "UTF-16le", mode: "fallback" },
  ])(
    "bounds $mode body fetches while preserving snippets in a $encoding database",
    async ({ encoding, mode }) => {
      const db = createDb();
      db.exec(`PRAGMA encoding = '${encoding}'`);
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
          id TEXT PRIMARY KEY, embedding FLOAT[2]
        )`);
      const texts = [
        "",
        "brief",
        "\0before and after\0",
        "abc😀de",
        "😀😀😀😀",
        "中文é\u0301\u2003memory",
        "\ud800unpaired\udfff",
        "a".repeat(2_799) + "😀" + "tail".repeat(4_000),
        "a".repeat(699) + "\0" + "tail".repeat(4_000),
        "文".repeat(16_000),
      ];
      for (const [index, text] of texts.entries()) {
        const id = `snippet-${index}`;
        insertFallbackChunk(db, { id, model: "target-model", vector: [1, index / 10] });
        db.prepare("UPDATE memory_index_chunks SET text = ? WHERE id = ?").run(text, id);
        db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
          id,
          vectorToBlob([1, index / 10]),
        );
      }
      // Read stored text first: the SQLite binding normalizes unpaired surrogates.
      const stored = db.prepare("SELECT id, text FROM memory_index_chunks ORDER BY rowid").all();
      let fetchedBytes = 0;
      const prepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        statement.get = new Proxy(statement.get.bind(statement), {
          apply(get, _receiver, values) {
            const row = get(...values);
            if (typeof row?.text === "string") {
              fetchedBytes += Buffer.byteLength(row.text);
            }
            return row;
          },
        });
        statement.all = new Proxy(statement.all.bind(statement), {
          apply(all, _receiver, values) {
            const rows = all(...values);
            for (const row of rows) {
              if (typeof row.text === "string") {
                fetchedBytes += Buffer.byteLength(row.text);
              }
            }
            return rows;
          },
        });
        return statement;
      });
      try {
        const snippetLimits = [1, 2, 3, 4, 7, 700];
        for (const snippetMaxChars of snippetLimits) {
          const results = await searchVectorFixture(db, {
            limit: texts.length,
            snippetMaxChars,
            ensureVectorReady: async () => mode === "KNN",
          });
          expect(results.map(({ id, snippet }) => ({ id, snippet }))).toEqual(
            stored.map(({ id, text }) => ({
              id,
              snippet: truncateUtf16Safe(String(text), snippetMaxChars),
            })),
          );
        }
        // Allow encoding expansion without materializing complete chunk bodies.
        const totalSnippetLimit = snippetLimits.reduce((sum, limit) => sum + limit, 0);
        expect(fetchedBytes).toBeLessThanOrEqual(texts.length * totalSnippetLimit * 8);
        if (mode === "fallback") {
          for (const snippetMaxChars of [
            0,
            -1,
            1.5,
            Number.NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER + 1,
          ]) {
            const results = await searchVectorFixture(db, {
              limit: texts.length,
              snippetMaxChars,
            });
            expect(results.map(({ id, snippet }) => ({ id, snippet }))).toEqual(
              stored.map(({ id, text }) => ({
                id,
                snippet: truncateUtf16Safe(String(text), snippetMaxChars),
              })),
            );
          }
        }
      } finally {
        prepareSpy.mockRestore();
      }
    },
  );

  it("falls back when filters hide matches beyond sqlite-vec's KNN cap", async () => {
    const db = createDb();
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
    });
    db.exec(`
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[2]
        );
      `);

    const insertVector = db.prepare(
      "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
    );
    const addChunk = (params: {
      id: string;
      model: string;
      source: "memory" | "sessions";
      vector: [number, number];
    }) => {
      insertFallbackChunk(db, params);
      insertVector.run(params.id, vectorToBlob(params.vector));
    };

    for (let i = 0; i < 20; i += 1) {
      addChunk({
        id: `other-${i}`,
        model: "other-model",
        source: "memory",
        vector: [1, 0],
      });
    }
    addChunk({
      id: "target",
      model: "target-model",
      source: "memory",
      vector: [0.5, 0.5],
    });
    addChunk({
      id: "alias",
      model: "alias-model",
      source: "memory",
      vector: [0.4, 0.6],
    });

    const belowCapResults = await searchVectorFixture(db, {
      providerModelAliases: ["alias-model"],
      limit: 2,
      ensureVectorReady: async () => true,
    });
    expect(belowCapResults.map((row) => row.id)).toEqual(["target", "alias"]);

    db.exec("BEGIN");
    for (let i = 20; i < 4097; i += 1) {
      addChunk({
        id: `other-${i}`,
        model: "other-model",
        source: "memory",
        vector: [1, 0],
      });
    }
    addChunk({
      id: "wrong-source",
      model: "target-model",
      source: "sessions",
      vector: [0.6, 0.4],
    });
    db.exec("COMMIT");

    const overLimitQuery = db.prepare(
      "SELECT id FROM memory_index_chunks_vec WHERE embedding MATCH ? AND k = ?",
    );
    expect(() => overLimitQuery.all(vectorToBlob([1, 0]), 4097)).toThrow(
      "k value in knn query too large, provided 4097 and the limit is 4096",
    );

    const results = await searchVectorFixture(db, {
      providerModelAliases: ["alias-model"],
      limit: 2,
      ensureVectorReady: async () => true,
      sourceFilterVec: { sql: " AND c.source IN (?)", params: ["memory"] },
      sourceFilterChunks: { sql: " AND source IN (?)", params: ["memory"] },
    });

    expect(results.map((row) => row.id)).toEqual(["target", "alias"]);
  });
  it.each([9_007_199_254_740_993n])(
    "scans the full signed rowid domain across sparse unsafe-integer batch boundaries from %s",
    async (firstHighRowid) => {
      const db = createFallbackDb();
      // Four low identities put an unsafe odd rowid at the first batch boundary;
      // retaining its exact bigint identity across the cursor boundary.
      const highRows = Array.from(
        { length: 252 },
        (_, index) => firstHighRowid + BigInt(index) * 2n,
      );
      const boundary = highRows.at(-1)!;
      const rowids = [
        -9_223_372_036_854_775_808n,
        -9_007_199_254_740_993n,
        -1n,
        0n,
        ...highRows,
        boundary + 1n,
        boundary + 2n,
        boundary + 1_000_000n,
        9_223_372_036_854_775_807n,
      ];
      const winnerIndex = 256;
      const runnerUpIndex = rowids.length - 1;
      const ids = rowids.map((_, index) => `row-${index}`);
      const insert = db.prepare(`INSERT INTO memory_index_chunks
          (chunk_rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          VALUES (?, ?, 'memory/boundary.md', 'memory', 1, 2, 'hash', 'target-model', 'boundary body', ?, 1)`);
      insert.setReadBigInts(true);
      for (const [index, rowid] of rowids.entries()) {
        const vector =
          index === winnerIndex ? [1, 0] : index === runnerUpIndex ? [0.8, 0.6] : [0, 1];
        insert.run(rowid, ids[index]!, encodeMemoryEmbedding(vector));
      }

      const scanned: string[] = [];
      db.function("observe_embedding", (id, embedding) => {
        scanned.push(String(id));
        if (scanned.length > rowids.length) {
          throw new Error("Fallback cursor repeated an already-scanned row");
        }
        return embedding;
      });
      db.exec(`
          ALTER TABLE memory_index_chunks RENAME TO observed_chunks;
          CREATE VIEW memory_index_chunks AS
            SELECT chunk_rowid AS rowid, id, path, source, start_line, end_line, model, text,
                   observe_embedding(id, embedding) AS embedding FROM observed_chunks;
        `);

      const results = await searchVectorFixture(db, { limit: rowids.length });
      expect(scanned).toEqual(ids);
      expect(results.map((result) => result.id)).toEqual([
        ids[winnerIndex],
        ids[runnerUpIndex],
        ...ids.filter((_, index) => index !== winnerIndex && index !== runnerUpIndex),
      ]);
      expect(results[0]?.score).toBe(1);
      expect(results[1]?.score).toBeCloseTo(0.8);
      expect(
        results.every(
          (result) => typeof result.startLine === "number" && typeof result.endLine === "number",
        ),
      ).toBe(true);
    },
  );
});
