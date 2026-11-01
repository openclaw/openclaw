import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { expect, it } from "vitest";
import { runVectorKnnQuery, vectorToBlob } from "./manager-search-knn.test-support.js";
import { searchChunksByEmbedding } from "./manager-search-vector.js";
import { searchKeywordWithFallback, searchPathKeyword } from "./manager-search.js";
import { insertKeywordFixture } from "./manager-search.test-support.js";
import { buildMemorySourceFilter } from "./source-filter.js";

it.each(["body", "body-fallback", "path", "vector-scan", "vector-knn"] as const)(
  "excludes sessions before %s limit, not same-path memory",
  async (mode) => {
    using db = openNodeSqliteDatabase(":memory:", { allowExtension: true });
    const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    expect(schema.ftsAvailable, schema.ftsError).toBe(true);
    const excludedPath = "sessions/a/recall.jsonl";
    const rows = [
      ["helper", "sessions", "recall", [1, 0], excludedPath],
      ["memory", "memory", "recall lunch", [0.8, 0.6], excludedPath],
      ["ordinary", "sessions", "recall lunch tomorrow", [0.9, 0.4], "sessions/z/recall.jsonl"],
    ] as const;
    for (const [id, source, text, vector, path] of rows) {
      insertKeywordFixture(db, { id, source, text, path });
      db.prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?").run(
        encodeMemoryEmbedding([...vector]),
        id,
      );
    }
    // Large exclusion sets must not consume one SQL parameter per path.
    const excludedPaths = [
      excludedPath,
      ...Array.from({ length: 33_000 }, (_, i) => `unused/${i}`),
    ];
    const keyword = {
      query: mode === "body-fallback" ? "recall absentword" : "recall",
      limit: 2,
      snippetMaxChars: 80,
      sourceFilter: buildMemorySourceFilter(undefined, ["memory", "sessions"], excludedPaths),
    };
    const vector = {
      ...keyword,
      db,
      providerModel: "mock-embed",
      queryVec: [1, 0],
    };
    let results: Array<{ id: string }>;
    if (mode === "path") {
      results = await searchPathKeyword({
        db,
        ...keyword,
        pathFtsTable: "memory_index_paths_fts",
      });
    } else if (mode === "body" || mode === "body-fallback") {
      const result = await searchKeywordWithFallback({
        db,
        body: { ...keyword, ftsTable: "memory_index_chunks_fts" },
        path: { ...keyword, pathFtsTable: "memory_index_paths_fts" },
      });
      expect(result).toMatchObject({ body: { error: undefined }, path: { error: undefined } });
      results = result.body.rows;
    } else if (mode === "vector-scan") {
      results = await searchChunksByEmbedding(vector);
    } else {
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      db.exec(
        "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
      );
      const insert = db.prepare(
        "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
      );
      for (const row of rows) {
        insert.run(row[0], vectorToBlob([...row[3]]));
      }
      const result = await runVectorKnnQuery(db, {
        ...vector,
        providerModels: ["mock-embed"],
        sourceFilter: buildMemorySourceFilter("c", ["memory", "sessions"], excludedPaths),
      });
      expect(result.fallbackScanRequired).toBe(false);
      results = result.rows;
    }
    expect(results.map((row) => row.id).toSorted()).toEqual(["memory", "ordinary"]);
  },
);
