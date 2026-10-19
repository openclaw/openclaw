import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { describe, expect, it } from "vitest";
import { runVectorKnnQuery, vectorToBlob } from "./manager-search-knn.test-support.js";
import { searchChunksByEmbedding } from "./manager-search-vector.js";
import { searchKeywordWithFallback, searchPathKeyword } from "./manager-search.js";
import { insertKeywordFixture } from "./manager-search.test-support.js";
import { buildMemorySourceFilter } from "./source-filter.js";

// This proves the engine's pre-limit contract independently of session metadata resolution.
describe("memory session candidate exclusions", () => {
  it.each(["body", "body-fallback", "path", "vector-scan", "vector-knn"] as const)(
    "excludes session paths before the %s limit and preserves a memory file with the same path",
    async (mode) => {
      using db = openNodeSqliteDatabase(":memory:", { allowExtension: true });
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      expect(schema.ftsAvailable, schema.ftsError).toBe(true);
      const excludedPath = "sessions/a/recall.jsonl";
      const rows = [
        {
          id: "helper",
          path: excludedPath,
          source: "sessions" as const,
          text: "recall",
          vector: [1, 0],
        },
        {
          id: "memory",
          path: excludedPath,
          source: "memory" as const,
          text: "recall lunch",
          vector: [0.8, 0.6],
        },
        {
          id: "ordinary",
          path: "sessions/z/recall.jsonl",
          source: "sessions" as const,
          text: "recall lunch tomorrow",
          vector: [0.9, 0.4],
        },
      ];
      for (const row of rows) {
        insertKeywordFixture(db, row);
        db.prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?").run(
          encodeMemoryEmbedding(row.vector),
          row.id,
        );
      }
      // Large exclusion sets must not consume one SQL parameter per path.
      const excludedPaths = [
        excludedPath,
        ...Array.from({ length: 33_000 }, (_, i) => `unused/${i}`),
      ];
      const sourceFilter = buildMemorySourceFilter(
        undefined,
        ["memory", "sessions"],
        excludedPaths,
      );
      const keyword = {
        query: mode === "body-fallback" ? "recall absentword" : "recall",
        limit: 2,
        snippetMaxChars: 80,
        sourceFilter,
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
        expect(result.body.error).toBeUndefined();
        expect(result.path.error).toBeUndefined();
        results = result.body.rows;
      } else if (mode === "vector-scan") {
        results = await searchChunksByEmbedding({
          db,
          sourceFilter,
          providerModel: "mock-embed",
          queryVec: [1, 0],
          limit: 2,
          snippetMaxChars: 80,
        });
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
          insert.run(row.id, vectorToBlob(row.vector));
        }
        const result = await runVectorKnnQuery(db, {
          providerModels: ["mock-embed"],
          queryVec: [1, 0],
          limit: 2,
          snippetMaxChars: 80,
          sourceFilter: buildMemorySourceFilter("c", ["memory", "sessions"], excludedPaths),
        });
        expect(result.fallbackScanRequired).toBe(false);
        results = result.rows;
      }
      expect(results.map((row) => row.id).toSorted()).toEqual(["memory", "ordinary"]);
    },
  );
});
