import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import {
  decodeMemoryEmbedding,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVectorKnnQuery } from "./manager-search-knn.js";
import { createEmbeddingScorer } from "./manager-search-scorer.js";
import { searchChunksByEmbedding, searchVector } from "./manager-search-vector.js";
import { runMemorySearchWithDeadline } from "./search-deadline.js";
import { vectorToBlob } from "./vector-blob.js";

function referenceCosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const av = expectDefined(a[i], `cosine vector a[${i}]`);
    const bv = expectDefined(b[i], `cosine vector b[${i}]`);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
      insertFallbackChunk(db, {
        id: "hidden",
        model: "/cache/default.gguf",
        vector: [1, 0],
        source: "sessions",
      });
      const candidateQuery: Parameters<typeof searchChunksByEmbedding>[0] = {
        db,
        providerModel: "canonical-model",
        providerModelAliases: ["/cache/default.gguf"],
        sourceFilter: { sql: " AND source IN (?)", params: ["memory"] },
        queryVec: [1, 0],
        limit: 5,
        snippetMaxChars: 200,
      };
      const selected = await searchChunksByEmbedding({
        ...candidateQuery,
        candidateIds: ["alias", "arbitrary", "hidden"],
      });
      expect(selected.map((row) => row.id)).toEqual(["alias"]);
      await expect(
        searchChunksByEmbedding({
          ...candidateQuery,
          candidateIds: [],
        }),
      ).resolves.toEqual([]);
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

  function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("scores blobs bit-identically to reference cosine over the decoded vector", () => {
    const random = seededRandom(7);
    const queryDims = 24;
    const queryVec = Array.from({ length: queryDims }, () => random() * 2 - 1);
    const score = createEmbeddingScorer(queryVec);
    const reference = (blob: Uint8Array) => referenceCosine(queryVec, decodeMemoryEmbedding(blob));
    const blobs: Uint8Array[] = [];
    // Equal, shorter and longer than the query, plus an empty and an all-zero vector.
    for (const dims of [queryDims, queryDims, 5, 1, queryDims + 9, 0]) {
      blobs.push(encodeMemoryEmbedding(Array.from({ length: dims }, () => random() * 2 - 1)));
    }
    blobs.push(encodeMemoryEmbedding(Array.from({ length: queryDims }, () => 0)));
    // Odd byte lengths.
    blobs.push(new Uint8Array([1, 2, 3]));
    // Truncated by a stray byte: a whole coordinate is present but the blob is still invalid.
    blobs.push(new Uint8Array([...encodeMemoryEmbedding([0.5, 0.25]), 7]));
    // Non-finite coordinates at the start, the end of the query prefix, and past it.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const vector = Array.from({ length: queryDims + 3 }, () => random());
      for (const position of [0, queryDims - 1, queryDims + 2]) {
        const bytes = encodeMemoryEmbedding(vector);
        new DataView(bytes.buffer).setFloat64(position * 8, bad, true);
        blobs.push(bytes);
      }
    }
    // Large finite coordinates whose squares overflow stay usable, as before.
    blobs.push(encodeMemoryEmbedding(Array.from({ length: queryDims }, () => 1e200)));
    // Blobs that are views into a larger buffer, at aligned and unaligned offsets, and a Buffer.
    const whole = encodeMemoryEmbedding(Array.from({ length: queryDims }, () => random() - 0.5));
    for (const offset of [1, 3, 8]) {
      const backing = new Uint8Array(whole.length + offset + 5);
      backing.set(whole, offset);
      blobs.push(backing.subarray(offset, offset + whole.length));
    }
    blobs.push(Buffer.from(whole));
    for (const blob of blobs) {
      expect(Object.is(score(blob), reference(blob))).toBe(true);
    }
  });

  it("preserves exact ranking without normalizing the query again for every row", async () => {
    const db = createFallbackDb();
    try {
      const random = seededRandom(20251003);
      const queryDims = 48;
      const limit = 7;
      const queryVec = Array.from({ length: queryDims }, () => random() * 2 - 1);
      const rows: Array<{ id: string; blob: Uint8Array }> = [];
      // Three full batches also exercise the final empty cursor read.
      const rowCount = 768;
      for (let index = 0; index < rowCount; index += 1) {
        const dims =
          index % 97 === 0 ? queryDims - 11 : index % 89 === 0 ? queryDims + 5 : queryDims;
        const vector = Array.from({ length: dims }, () => random() * 2 - 1);
        const id = `chunk-${index}`;
        insertFallbackChunk(db, { id, model: "target-model", vector });
        let blob = encodeMemoryEmbedding(vector);
        if (index % 101 === 0) {
          blob = new Uint8Array([9, 9, 9]);
          db.prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?").run(blob, id);
        }
        rows.push({ id, blob });
      }
      const expected = rows
        .map(({ id, blob }) => ({
          id,
          score: referenceCosine(queryVec, decodeMemoryEmbedding(blob)),
        }))
        .filter((row) => Number.isFinite(row.score))
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit);

      const sqrt = vi.spyOn(Math, "sqrt");
      try {
        const results = await searchVectorFixture(db, { queryVec, limit });
        expect(results.map(({ id, score }) => ({ id, score }))).toEqual(expected);
        // Allow one norm per stored vector and one per query prefix, without timing noise.
        expect(sqrt.mock.calls.length).toBeLessThanOrEqual(rowCount + queryDims);
      } finally {
        sqrt.mockRestore();
      }
    } finally {
      db.close();
    }
  });

  it("picks up rows inserted during the inter-batch event-loop yield (rowid cursor)", async () => {
    // Regression #81172: a synchronous scan cannot observe these scheduled inserts.
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
    } finally {
      db.close();
    }
  });
});
