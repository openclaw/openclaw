import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
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
import { runVectorKnnQuery, vectorToBlob } from "./manager-search-knn.test-support.js";
import { createEmbeddingScorer } from "./manager-search-scorer.js";
import { searchChunksByEmbedding, searchVector } from "./manager-search-vector.js";

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

function search(db: DatabaseSync, options: Partial<VectorSearchOptions> = {}) {
  const { sourceFilterChunks = { sql: "", params: [] }, ...overrides } = options;
  const request: Omit<Parameters<typeof searchVector>[0], "runFallback"> = {
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
      searchChunksByEmbedding({ ...request, db, sourceFilter: sourceFilterChunks }),
  });
}

describe("searchVector sqlite-vec KNN", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("stops fallback scanning when the caller aborts and keeps later searches healthy", async () => {
    using db = createFallbackDb();
    for (let index = 0; index < 4096; index += 1) {
      insertFallbackChunk(db, `chunk-${index}`, index === 4095 ? [1, 0] : [0, 1]);
    }

    let scannedRows = 0;
    db.function("observe_embedding", (embedding) => {
      scannedRows += 1;
      return embedding;
    });
    observeEmbeddings(db);
    const caller = new AbortController();
    const abortReason = new Error("caller stopped memory search");
    const pending = search(db, { signal: caller.signal });
    setImmediate(() => caller.abort(abortReason));

    await expect(pending).rejects.toBe(abortReason);
    const rowsAtAbort = scannedRows;
    expect(rowsAtAbort).toBeGreaterThan(0);
    expect(rowsAtAbort).toBeLessThan(4096);
    await yieldToEventLoop();
    await yieldToEventLoop();
    expect(scannedRows).toBe(rowsAtAbort);

    const healthyResults = await search(db, { limit: 1 });
    expect(healthyResults.map((result) => result.id)).toEqual(["chunk-4095"]);
  });

  function createFallbackDb(): InstanceType<typeof DatabaseSync> {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    return db;
  }

  function insertFallbackChunk(
    db: DatabaseSync,
    id: string,
    vector: number[],
    model = "target-model",
    source: "memory" | "sessions" = "memory",
  ) {
    db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, 1)`).run(
      id,
      `memory/${id}.md`,
      source,
      id,
      model,
      `chunk ${id}`,
      encodeMemoryEmbedding(vector),
    );
  }

  function observeEmbeddings(db: DatabaseSync) {
    db.exec(`
        ALTER TABLE memory_index_chunks RENAME TO observed_chunks;
        CREATE VIEW memory_index_chunks AS
          SELECT chunk_rowid AS rowid, id, path, source, start_line, end_line, model, text,
                 observe_embedding(embedding) AS embedding
          FROM observed_chunks;
      `);
  }

  it.each([9_007_199_254_740_993n])(
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

        const results = await search(db, { limit: rowids.length });
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
    using db = createFallbackDb();
    insertFallbackChunk(db, "canonical", [1, 0], "canonical-model");
    insertFallbackChunk(db, "alias", [0.9, 0.1], "/cache/default.gguf");
    insertFallbackChunk(db, "arbitrary", [1, 0], "/other/default.gguf");

    const results = await search(db, {
      providerModel: "canonical-model",
      providerModelAliases: ["/cache/default.gguf"],
    });

    expect(results.map((row) => row.id)).toEqual(["canonical", "alias"]);
    insertFallbackChunk(db, "hidden", [1, 0], "/cache/default.gguf", "sessions");
    const candidateQuery: Omit<Parameters<typeof searchChunksByEmbedding>[0], "candidateIds"> = {
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
    for (const dims of [queryDims, queryDims, 5, 1, queryDims + 9, 0]) {
      blobs.push(encodeMemoryEmbedding(Array.from({ length: dims }, () => random() * 2 - 1)));
    }
    blobs.push(encodeMemoryEmbedding(Array.from({ length: queryDims }, () => 0)));
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
    using db = createFallbackDb();
    const random = seededRandom(20251003);
    const queryDims = 48;
    const limit = 7;
    const queryVec = Array.from({ length: queryDims }, () => random() * 2 - 1);
    const rows: Array<{ id: string; blob: Uint8Array }> = [];
    // Three full batches also exercise the final empty cursor read.
    const rowCount = 768;
    for (let index = 0; index < rowCount; index += 1) {
      const dims = index % 97 === 0 ? queryDims - 11 : index % 89 === 0 ? queryDims + 5 : queryDims;
      const vector = Array.from({ length: dims }, () => random() * 2 - 1);
      const id = `chunk-${index}`;
      insertFallbackChunk(db, id, vector);
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

    using sqrt = vi.spyOn(Math, "sqrt");
    const results = await search(db, { queryVec, limit });
    expect(results.map(({ id, score }) => ({ id, score }))).toEqual(expected);
    // Allow one norm per stored vector and one per query prefix, without timing noise.
    expect(sqrt.mock.calls.length).toBeLessThanOrEqual(rowCount + queryDims);
  });

  it("picks up rows inserted during the inter-batch event-loop yield (rowid cursor)", async () => {
    // Regression #81172: a synchronous scan cannot observe these scheduled inserts.
    using db = createFallbackDb();
    // 257 baseline rows: first batch sees 256 (score 0 vs. query), second
    // batch would have seen just 1 until our setImmediate insert lands.
    for (let i = 0; i < 257; i += 1) {
      insertFallbackChunk(db, `baseline-${i}`, [0, 1]);
    }

    let inserted = false;
    setImmediate(() => {
      inserted = true;
      insertFallbackChunk(db, "winner-A", [1, 0]);
      insertFallbackChunk(db, "winner-B", [0.9, 0.1]);
    });

    const results = await search(db, { limit: 2 });

    expect(inserted).toBe(true);
    expect(results.map((r) => r.id)).toEqual(["winner-A", "winner-B"]);
  });

  function expectedChunk(id: string, snippet: string) {
    return {
      id,
      path: `memory/${id}.md`,
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet,
      source: "memory",
    };
  }

  it("keeps scored payloads and equal-score ordering when chunks change between batches", async () => {
    using db = createFallbackDb();
    for (let index = 0; index < 257; index += 1) {
      insertFallbackChunk(db, `chunk-${index}`, index < 2 || index === 256 ? [1, 0] : [0, 1]);
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

    const results = await search(db, { limit: 2, snippetMaxChars: 5 });
    await changed;
    expect(results).toEqual([expectedChunk("chunk-0", "old "), expectedChunk("chunk-1", "chunk")]);
  });

  it("reads contender payloads from the scored batch snapshot during external writes", async () => {
    const filename = nodePath.join(tempDirs.make("memory-search-snapshot-"), "memory.sqlite");
    using db = new DatabaseSync(filename);
    using writer = new DatabaseSync(filename);
    db.exec("PRAGMA journal_mode = WAL");
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    insertFallbackChunk(db, "winner", [1, 0]);
    observeEmbeddings(db);
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

    const results = await search(db, { limit: 1 });
    expect(replaced).toBe(true);
    expect(results[0]).toMatchObject({ id: "winner", score: 1, snippet: "chunk winner" });
    expect(writer.prepare("SELECT text FROM observed_chunks").get()?.text).toBe(
      "replacement payload",
    );
  });

  it("bounds fallback body fetches while preserving UTF-8 snippets", async () => {
    using db = new DatabaseSync(":memory:", { allowExtension: true });
    db.exec("PRAGMA encoding = 'UTF-8'");
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
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
      insertFallbackChunk(db, id, [1, index / 10]);
      db.prepare("UPDATE memory_index_chunks SET text = ? WHERE id = ?").run(text, id);
    }
    // Read stored text first: the SQLite binding normalizes unpaired surrogates.
    const stored = db.prepare("SELECT id, text FROM memory_index_chunks ORDER BY rowid").all();
    const expectSnippets = (results: Awaited<ReturnType<typeof search>>, limit: number) =>
      expect(results.map(({ id, snippet }) => ({ id, snippet }))).toEqual(
        stored.map(({ id, text }) => ({ id, snippet: truncateUtf16Safe(String(text), limit) })),
      );
    let fetchedBytes = 0;
    const observeText = (row: { text?: unknown } | undefined) => {
      if (typeof row?.text === "string") {
        fetchedBytes += Buffer.byteLength(row.text);
      }
    };
    const prepare = db.prepare.bind(db);
    using prepareSpy = vi.spyOn(db, "prepare");
    prepareSpy.mockImplementation((sql) => {
      const statement = prepare(sql);
      statement.get = new Proxy(statement.get.bind(statement), {
        apply(get, _receiver, values) {
          const row = get(...values);
          observeText(row);
          return row;
        },
      });
      statement.all = new Proxy(statement.all.bind(statement), {
        apply(all, _receiver, values) {
          const rows = all(...values);
          for (const row of rows) {
            observeText(row);
          }
          return rows;
        },
      });
      return statement;
    });
    const checkLimit = async (snippetMaxChars: number) =>
      expectSnippets(await search(db, { limit: texts.length, snippetMaxChars }), snippetMaxChars);
    const snippetLimits = [1, 2, 3, 4, 7, 700];
    for (const snippetMaxChars of snippetLimits) {
      await checkLimit(snippetMaxChars);
    }
    // Allow encoding expansion without materializing complete chunk bodies.
    const totalSnippetLimit = snippetLimits.reduce((sum, limit) => sum + limit, 0);
    expect(fetchedBytes).toBeLessThanOrEqual(texts.length * totalSnippetLimit * 8);
    for (const snippetMaxChars of [
      0,
      -1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await checkLimit(snippetMaxChars);
    }
  });

  it("falls back when filters hide matches beyond sqlite-vec's KNN cap", async () => {
    using db = new DatabaseSync(":memory:", { allowExtension: true });
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    db.exec(`
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[2]
        );
      `);

    const insertVector = db.prepare(
      "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
    );
    const addChunk = (
      id: string,
      vector: [number, number],
      model = "target-model",
      source: "memory" | "sessions" = "memory",
    ) => {
      insertFallbackChunk(db, id, vector, model, source);
      insertVector.run(id, vectorToBlob(vector));
    };

    for (let i = 0; i < 20; i += 1) {
      addChunk(`other-${i}`, [1, 0], "other-model");
    }
    addChunk("target", [0.5, 0.5]);
    addChunk("alias", [0.4, 0.6], "alias-model");

    const knnOptions = {
      providerModelAliases: ["alias-model"],
      limit: 2,
      ensureVectorReady: async () => true,
    };
    const belowCapResults = await search(db, knnOptions);
    expect(belowCapResults.map((row) => row.id)).toEqual(["target", "alias"]);

    db.exec("BEGIN");
    for (let i = 20; i < 4097; i += 1) {
      addChunk(`other-${i}`, [1, 0], "other-model");
    }
    addChunk("wrong-source", [0.6, 0.4], "target-model", "sessions");
    db.exec("COMMIT");

    const overLimitQuery = db.prepare(
      "SELECT id FROM memory_index_chunks_vec WHERE embedding MATCH ? AND k = ?",
    );
    expect(() => overLimitQuery.all(vectorToBlob([1, 0]), 4097)).toThrow(
      "k value in knn query too large, provided 4097 and the limit is 4096",
    );

    const results = await search(db, {
      ...knnOptions,
      sourceFilterVec: { sql: " AND c.source IN (?)", params: ["memory"] },
      sourceFilterChunks: { sql: " AND source IN (?)", params: ["memory"] },
    });

    expect(results.map((row) => row.id)).toEqual(["target", "alias"]);
  });
});
