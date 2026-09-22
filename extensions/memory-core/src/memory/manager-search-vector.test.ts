import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVectorKnnQuery } from "./manager-search-knn.js";
import { searchVector } from "./manager-search-vector.js";
import { runMemorySearchWithDeadline } from "./search-deadline.js";
import { vectorToBlob } from "./vector-blob.js";

type VectorSearchOptions = Omit<Parameters<typeof searchVector>[0], "db">;

function searchVectorFixture(db: DatabaseSync, options: Partial<VectorSearchOptions> = {}) {
  return searchVector({
    db,
    vectorTable: "memory_index_chunks_vec",
    providerModel: "target-model",
    queryVec: [1, 0],
    limit: 5,
    snippetMaxChars: 200,
    ensureVectorReady: async () => false,
    runVectorKnn: async (request) => runVectorKnnQuery(db, request),
    sourceFilterVec: { sql: "", params: [] },
    sourceFilterChunks: { sql: "", params: [] },
    ...options,
  });
}

describe("searchVector sqlite-vec KNN", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("yields to the event loop during large fallback scans (issue #81172)", async () => {
    // Real Nextcloud-scale corpus where the vec0 fast path is unavailable
    // (e.g., extension not loaded or dimension mismatch with active model)
    // used to pin the main thread for the entire fallback scan, blocking
    // channel I/O. After fix the loop yields after each full
    // FALLBACK_VECTOR_BATCH_SIZE batch so a setImmediate-scheduled task can
    // interleave between batches.
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: false,
      });

      const insertChunk = db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      // Just over 3x the yield batch (FALLBACK_VECTOR_BATCH_SIZE=256), so we
      // expect at least 3 yield points to fire during the scan.
      const N = 1024;
      for (let i = 0; i < N; i += 1) {
        insertChunk.run(
          `chunk-${i}`,
          `memory/chunk-${i}.md`,
          "memory",
          1,
          1,
          `hash-${i}`,
          "yield-model",
          `chunk ${i}`,
          // Tiny 2-dim embeddings: the test asserts the yielding *cadence*,
          // not real similarity scoring (other tests cover scoring).
          encodeMemoryEmbedding([Math.cos(i), Math.sin(i)]),
          i,
        );
      }

      // Heartbeat captures whether the event loop gets a chance to run between
      // setImmediate batches. With the pre-fix synchronous loop, this would
      // fire zero times during searchVector. With the fix it should fire at
      // least once because we yield ≥3 times across 1024 rows.
      let heartbeats = 0;
      const heartbeatInterval = setInterval(() => {
        heartbeats += 1;
      }, 0);

      try {
        const results = await searchVectorFixture(db, {
          providerModel: "yield-model",
          limit: 4,
        });
        expect(results).toHaveLength(4);
        // ≥1 heartbeat proves the event loop was given a chance to run during
        // the scan. (Exact counts depend on machine speed; we only check the
        // qualitative property that the loop is no longer fully blocked.)
        expect(heartbeats).toBeGreaterThan(0);
      } finally {
        clearInterval(heartbeatInterval);
      }
    } finally {
      db.close();
    }
  });

  it("stops fallback scanning when the caller aborts and keeps later searches healthy", async () => {
    const db = createFallbackDb();
    try {
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
    } finally {
      db.close();
    }
  });

  // ===== Fallback path boundary coverage (issue #81172 review diligence) =====

  function createFallbackDb(): InstanceType<typeof DatabaseSync> {
    const db = new DatabaseSync(":memory:");
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
    },
  ): void {
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      params.id,
      `memory/${params.id}.md`,
      "memory",
      1,
      1,
      params.id,
      params.model,
      `chunk ${params.id}`,
      encodeMemoryEmbedding(params.vector),
      1,
    );
  }

  it.each([9_007_199_254_740_993n, 9_007_199_254_740_995n])(
    "scans the full signed rowid domain across sparse unsafe-integer batch boundaries from %s",
    async (firstHighRowid) => {
      const db = createFallbackDb();
      try {
        // Four low identities put an unsafe odd rowid at the first batch boundary;
        // the two starting values exercise both Number rounding directions.
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
      } finally {
        db.close();
      }
    },
  );

  it("returns an empty result set when no chunks match the provider model", async () => {
    const db = createFallbackDb();
    try {
      // One chunk with a different model must not appear in results.
      insertFallbackChunk(db, { id: "other-only", model: "other-model", vector: [1, 0] });
      const results = await searchVectorFixture(db);
      expect(results).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("searches provider-declared model aliases while excluding arbitrary paths", async () => {
    const db = createFallbackDb();
    try {
      insertFallbackChunk(db, { id: "canonical", model: "canonical-model", vector: [1, 0] });
      insertFallbackChunk(db, { id: "alias", model: "/cache/default.gguf", vector: [0.9, 0.1] });
      insertFallbackChunk(db, { id: "arbitrary", model: "/other/default.gguf", vector: [1, 0] });

      const results = await searchVectorFixture(db, {
        providerModel: "canonical-model",
        providerModelAliases: ["/cache/default.gguf"],
      });

      expect(results.map((row) => row.id)).toEqual(["canonical", "alias"]);
    } finally {
      db.close();
    }
  });

  it("searches an empty primary model without requiring aliases", async () => {
    const db = createFallbackDb();
    try {
      insertFallbackChunk(db, { id: "empty-primary", model: "", vector: [1, 0] });
      insertFallbackChunk(db, { id: "other", model: "other-model", vector: [1, 0] });

      const results = await searchVectorFixture(db, { providerModel: "" });

      expect(results.map((row) => row.id)).toEqual(["empty-primary"]);
    } finally {
      db.close();
    }
  });

  it("handles a single matching row (below the yield batch size)", async () => {
    const db = createFallbackDb();
    try {
      insertFallbackChunk(db, { id: "lone", model: "target-model", vector: [1, 0] });
      const results = await searchVectorFixture(db);
      expect(results.map((r) => r.id)).toEqual(["lone"]);
    } finally {
      db.close();
    }
  });

  it("keeps malformed binary vectors inert without interrupting fallback search", async () => {
    const db = createFallbackDb();
    try {
      const malformed = [new Uint8Array([1, 2, 3]), new Uint8Array([0, 0, 0, 0, 0, 0, 240, 127])];
      for (const [index, embedding] of malformed.entries()) {
        const id = `malformed-${index}`;
        insertFallbackChunk(db, { id, model: "target-model", vector: [] });
        db.prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?").run(embedding, id);
      }
      insertFallbackChunk(db, { id: "healthy", model: "target-model", vector: [1, 0] });

      const results = await searchVectorFixture(db);

      expect(results.map(({ id, score }) => ({ id, score }))).toEqual([
        { id: "healthy", score: 1 },
        { id: "malformed-0", score: 0 },
        { id: "malformed-1", score: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("handles an exact batch-size boundary (FALLBACK_VECTOR_BATCH_SIZE rows)", async () => {
    // When N === FALLBACK_VECTOR_BATCH_SIZE exactly, the loop produces one
    // full batch and then must take one extra empty-batch step before
    // breaking; verify no row is dropped or double-counted at the seam.
    const db = createFallbackDb();
    try {
      const N = 256;
      for (let i = 0; i < N; i += 1) {
        // Each chunk gets a unique vector so cosine scoring is well-defined.
        insertFallbackChunk(db, {
          id: `chunk-${i}`,
          model: "target-model",
          vector: [Math.cos(i), Math.sin(i)],
        });
      }
      const results = await searchVectorFixture(db, { limit: 3 });
      expect(results).toHaveLength(3);
      // Strictly decreasing scores confirms top-K maintenance is intact.
      let previous = expectDefined(results[0], "first vector-search result");
      for (const current of results.slice(1)) {
        expect(previous.score).toBeGreaterThan(current.score);
        previous = current;
      }
    } finally {
      db.close();
    }
  });

  it("preserves top-K ordering vs. a naive reference cosine implementation", async () => {
    // Guards against accidental algorithmic regressions from the control-flow
    // refactor: insert 200 chunks with random vectors and assert our patched
    // fallback search returns the same top-K by id, in the same order, as a
    // straight-line JS reference that scores every row.
    const db = createFallbackDb();
    try {
      const dim = 16;
      const N = 200;
      const limit = 5;
      // Use a deterministic seed-free PRNG-equivalent: hash-derived floats so
      // the test is repeatable across machines.
      const vectorFor = (i: number, j: number): number => {
        const s = Math.sin(i * 31 + j * 17 + 3) * 1000;
        return s - Math.floor(s) - 0.5;
      };
      const chunks: Array<{ id: string; vector: number[] }> = [];
      for (let i = 0; i < N; i += 1) {
        const vector = Array.from({ length: dim }, (_, j) => vectorFor(i, j));
        chunks.push({ id: `chunk-${i}`, vector });
        insertFallbackChunk(db, { id: `chunk-${i}`, model: "target-model", vector });
      }
      const queryVec = Array.from({ length: dim }, (_, j) => vectorFor(-1, j));

      function refCosine(a: number[], b: number[]): number {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i += 1) {
          const aValue = expectDefined(a[i], `cosine vector a[${i}]`);
          const bValue = expectDefined(b[i], `cosine vector b[${i}]`);
          dot += aValue * bValue;
          normA += aValue * aValue;
          normB += bValue * bValue;
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
      }
      const referenceTopIds = chunks
        .map((c) => ({ id: c.id, score: refCosine(queryVec, c.vector) }))
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.id);

      const results = await searchVectorFixture(db, {
        queryVec,
        limit,
      });
      expect(results.map((r) => r.id)).toEqual(referenceTopIds);
    } finally {
      db.close();
    }
  });

  it("picks up rows inserted during the inter-batch event-loop yield (rowid cursor)", async () => {
    // The fix's rowid-paginated batches yield via setImmediate between batches.
    // Schedule an INSERT to land in that yield gap and verify the search picks
    // up the new rows in the next batch: no double-counting, no missed rows.
    const db = createFallbackDb();
    try {
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

      // setImmediate fires during the search's first inter-batch yield. We
      // queue an insert of two near-perfect matches; their rowids (258, 259)
      // are strictly greater than `lastRowid` (256), so the rowid cursor
      // must include them in batch 2.
      let inserted = false;
      const insertDuringYield = (): void => {
        if (inserted) {
          return;
        }
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
      };
      setImmediate(insertDuringYield);

      const results = await searchVectorFixture(db, { limit: 2 });

      // The winners must dominate the top-2. If the rowid cursor were broken
      // (either skipping or duplicating rows past the yield), one of these
      // would be wrong.
      expect(inserted).toBe(true);
      expect(results.map((r) => r.id)).toEqual(["winner-A", "winner-B"]);
    } finally {
      db.close();
    }
  });

  it("keeps scored payloads and equal-score ordering when chunks change between batches", async () => {
    const db = createFallbackDb();
    try {
      for (let index = 0; index < 257; index += 1) {
        insertFallbackChunk(db, {
          id: `chunk-${index}`,
          model: "target-model",
          vector: index < 2 || index === 256 ? [1, 0] : [0, 1],
        });
      }
      db.prepare("UPDATE memory_index_chunks SET text = ? WHERE id = ?").run(
        "old 😀 text",
        "chunk-0",
      );
      const changed = new Promise<void>((resolve) => {
        setImmediate(() => {
          db.prepare("UPDATE memory_index_chunks SET text = ?, embedding = ? WHERE id = ?").run(
            "replacement",
            encodeMemoryEmbedding([0, 1]),
            "chunk-0",
          );
          resolve();
        });
      });

      const results = await searchVectorFixture(db, { limit: 2, snippetMaxChars: 5 });
      await changed;
      expect(results).toEqual([
        {
          id: "chunk-0",
          path: "memory/chunk-0.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "old ",
          source: "memory",
        },
        {
          id: "chunk-1",
          path: "memory/chunk-1.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "chunk",
          source: "memory",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("reads contender payloads from the scored batch snapshot during external writes", async () => {
    const filename = nodePath.join(tempDirs.make("memory-search-snapshot-"), "memory.sqlite");
    const db = new DatabaseSync(filename);
    const writer = new DatabaseSync(filename);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      insertFallbackChunk(db, { id: "winner", model: "target-model", vector: [1, 0] });
      db.exec(`
        ALTER TABLE memory_index_chunks RENAME TO observed_chunks;
        CREATE VIEW memory_index_chunks AS
          SELECT chunk_rowid AS rowid, id, path, source, start_line, end_line, model, text,
                 observe_embedding(embedding) AS embedding
          FROM observed_chunks;
      `);
      let replaced = false;
      db.function("observe_embedding", (embedding) => {
        if (!replaced) {
          writer
            .prepare("UPDATE observed_chunks SET text = ?, embedding = ? WHERE id = ?")
            .run("replacement payload", encodeMemoryEmbedding([0, 1]), "winner");
          replaced = true;
        }
        return embedding;
      });

      const results = await searchVectorFixture(db, { limit: 1 });
      expect(replaced).toBe(true);
      expect(results[0]).toMatchObject({ id: "winner", score: 1, snippet: "chunk winner" });
      expect(writer.prepare("SELECT text FROM observed_chunks").get()?.text).toBe(
        "replacement payload",
      );
    } finally {
      writer.close();
      db.close();
    }
  });

  it.each(
    ["UTF-8", "UTF-16le", "UTF-16be"].flatMap((encoding) =>
      ["KNN", "fallback"].map((mode) => ({ encoding, mode })),
    ),
  )(
    "bounds $mode body fetches while preserving snippets in a $encoding database",
    async ({ encoding, mode }) => {
      const db = new DatabaseSync(":memory:", { allowExtension: true });
      try {
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
      } finally {
        db.close();
      }
    },
  );

  it("falls back when filters hide matches beyond sqlite-vec's KNN cap", async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    try {
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

      const insertChunk = db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertVector = db.prepare(
        "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
      );
      const addChunk = (params: {
        id: string;
        model: string;
        source: "memory" | "sessions";
        vector: [number, number];
      }) => {
        insertChunk.run(
          params.id,
          `memory/${params.id}.md`,
          params.source,
          1,
          1,
          params.id,
          params.model,
          `chunk ${params.id}`,
          encodeMemoryEmbedding(params.vector),
          1,
        );
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
    } finally {
      db.close();
    }
  });
});
