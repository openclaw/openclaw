import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./hybrid.js";
import { searchKeyword } from "./manager-search.js";

describe("searchKeyword trigram fallback", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function createTrigramDb() {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      cacheEnabled: false,
      ftsTable: "chunks_fts",
      ftsEnabled: true,
      ftsTokenizer: "trigram",
    });
    return db;
  }

  async function runSearch(params: {
    rows: Array<{ id: string; path: string; text: string }>;
    query: string;
  }) {
    const db = createTrigramDb();
    try {
      const insert = db.prepare(
        "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of params.rows) {
        insert.run(row.text, row.id, row.path, "memory", "mock-embed", 1, 1);
      }
      return await searchKeyword({
        db,
        ftsTable: "chunks_fts",
        providerModel: "mock-embed",
        query: params.query,
        ftsTokenizer: "trigram",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });
    } finally {
      db.close();
    }
  }

  it("finds short Chinese queries with substring fallback", async () => {
    const results = await runSearch({
      rows: [{ id: "1", path: "memory/zh.md", text: "今天玩成语接龙游戏" }],
      query: "成语",
    });
    expect(results.map((row) => row.id)).toContain("1");
    expect(results[0]?.textScore).toBe(1);
  });

  it("finds short Japanese and Korean queries with substring fallback", async () => {
    const japaneseResults = await runSearch({
      rows: [{ id: "jp", path: "memory/jp.md", text: "今日はしりとり大会" }],
      query: "しり とり",
    });
    expect(japaneseResults.map((row) => row.id)).toEqual(["jp"]);

    const koreanResults = await runSearch({
      rows: [{ id: "ko", path: "memory/ko.md", text: "오늘 끝말잇기 게임을 했다" }],
      query: "끝말",
    });
    expect(koreanResults.map((row) => row.id)).toEqual(["ko"]);
  });

  it("keeps MATCH semantics for long trigram terms while requiring short CJK substrings", async () => {
    const results = await runSearch({
      rows: [
        { id: "match", path: "memory/good.md", text: "今天玩成语接龙游戏" },
        { id: "partial", path: "memory/partial.md", text: "今天玩成语接龙" },
      ],
      query: "成语接龙 游戏",
    });
    expect(results.map((row) => row.id)).toEqual(["match"]);
    expect(results[0]?.textScore).toBeGreaterThan(0);
  });
});
