import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { mergeHybridResults, selectHybridSearchResults } from "./hybrid.js";
import { searchChunksByEmbedding } from "./manager-search-vector.js";
import { searchKeyword, searchPathKeyword } from "./manager-search.js";
import { createMemorySearchDb, insertKeywordFixture } from "./manager-search.test-support.js";

describe("hybrid ranking with real SQLite query scores", () => {
  it("calibrates lexical credit without changing query confidence, exact paths or minScore", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      expect(schema.ftsAvailable).toBe(true);
      const rows = [
        { id: "full", text: "orbital telescope calibration", cosine: 0.3 },
        { id: "weak", text: "orbital unrelated unrelated unrelated", cosine: 0.35 },
        { id: "semantic", text: "observatory optical alignment", cosine: 0.4 },
      ];
      for (const row of rows) {
        insertKeywordFixture(db, { id: row.id, path: "memory/" + row.id + ".md", text: row.text });
        db.prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?").run(
          encodeMemoryEmbedding([row.cosine, Math.sqrt(1 - row.cosine ** 2)]),
          row.id,
        );
      }
      const keywordOptions = {
        db,
        ftsTable: "memory_index_chunks_fts",
        ftsTokenizer: "unicode61" as const,
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
      };
      const keyword = (
        await searchKeyword({ ...keywordOptions, query: "orbital telescope calibration" })
      ).map((entry) => Object.assign({}, entry, { rankingScore: entry.score }));
      const vector = (
        await searchChunksByEmbedding({
          db,
          providerModel: "mock-embed",
          sourceFilter: { sql: "", params: [] },
          queryVec: [1, 0],
          limit: 10,
          snippetMaxChars: 200,
        })
      ).map((entry) => Object.assign({}, entry, { vectorScore: entry.score }));
      expect(vector.map((row) => row.id)).toEqual(["semantic", "weak", "full"]);
      expect(keyword[0]?.id).toBe("full");
      const before = structuredClone({ keyword, vector });
      const merged = await mergeHybridResults({
        vector,
        keyword,
        vectorWeight: 0.7,
        textWeight: 0.3,
      });
      expect(merged[0]?.path).toBe("memory/full.md");
      expect(keyword[0]!.score).toBeGreaterThan(0.4);
      const full = merged.find((row) => row.path === "memory/full.md");
      expect(full?.score).toBeCloseTo(0.7 * 0.3 + 0.3 * Math.min(keyword[0]!.score, 0.4));
      expect({ keyword, vector }).toEqual(before);
      expect(
        selectHybridSearchResults({
          merged,
          keyword,
          vectorCandidates: vector,
          maxResults: 10,
          minScore: 0.27,
        }).some((row) => row.path === "memory/semantic.md"),
      ).toBe(true);
      expect(
        selectHybridSearchResults({
          merged,
          keyword,
          vectorCandidates: vector,
          maxResults: 10,
          minScore: 0.29,
        }).some((row) => row.path === "memory/semantic.md"),
      ).toBe(false);
      const lexical = await mergeHybridResults({
        vector: [],
        keyword,
        vectorWeight: 0.7,
        textWeight: 0.3,
      });
      expect(lexical.find((row) => row.path === "memory/full.md")?.textScore).toBe(
        keyword[0]?.score,
      );
      expect(lexical.find((row) => row.path === "memory/full.md")?.score).toBeCloseTo(
        0.3 * keyword[0]!.score,
      );
      const exact = await searchPathKeyword({
        ...keywordOptions,
        pathFtsTable: "memory_index_paths_fts",
        query: "semantic.md",
      });
      expect(exact[0]?.exactPathSpecificity).toBe(2);
      const exactMerged = await mergeHybridResults({
        vector,
        keyword: exact,
        vectorWeight: 0.7,
        textWeight: 0.3,
      });
      expect(exactMerged[0]?.path).toBe("memory/semantic.md");
      expect(exactMerged[0]?.score).toBe(1);
    } finally {
      db.close();
    }
  });
});
