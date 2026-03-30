import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { extractKeywords } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./hybrid.js";
import { searchKeyword } from "./manager-search.js";

/**
 * Validates the motivation for enabling query expansion in hybrid search mode.
 *
 * In hybrid mode the FTS component uses `buildFtsQuery`, which AND-joins every
 * token. For conversational queries this means stop words like "what", "that",
 * "about" must ALL appear in the indexed text — otherwise FTS returns nothing.
 * Passing `extractKeywords`-cleaned input removes stop words so the FTS query
 * focuses on meaningful terms, dramatically improving keyword-side recall.
 */
describe("hybrid query expansion improves FTS recall", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function createDb(tokenizer: "unicode61" | "trigram" = "unicode61") {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      cacheEnabled: false,
      ftsTable: "chunks_fts",
      ftsEnabled: true,
      ftsTokenizer: tokenizer,
    });
    return db;
  }

  async function runSearch(params: {
    rows: Array<{ id: string; path: string; text: string }>;
    query: string;
    tokenizer?: "unicode61" | "trigram";
  }) {
    const tokenizer = params.tokenizer ?? "unicode61";
    const db = createDb(tokenizer);
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
        ftsTokenizer: tokenizer,
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

  const indexedRows = [
    {
      id: "1",
      path: "memory/2026-01-01.md",
      text: "Store API keys in environment variables for security",
    },
    {
      id: "2",
      path: "memory/2026-01-02.md",
      text: "PostgreSQL chosen as the primary database with Prisma ORM",
    },
  ];

  it("raw conversational query returns no FTS results (AND too restrictive)", async () => {
    const results = await runSearch({
      rows: indexedRows,
      query: "what was that thing about API keys",
    });
    // AND query: "what" AND "was" AND "that" AND "thing" AND "about" AND "API" AND "keys"
    // Indexed text doesn't contain "what", "was", "that", "thing" → 0 results
    expect(results).toHaveLength(0);
  });

  it("extracted keywords produce FTS results for the same query", async () => {
    const keywords = extractKeywords("what was that thing about API keys");
    expect(keywords.length).toBeGreaterThan(0);

    const results = await runSearch({
      rows: indexedRows,
      query: keywords.join(" "),
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("1");
  });

  it("conversational database query benefits from keyword extraction", async () => {
    const raw = "what is the database and the ORM";
    const rawResults = await runSearch({ rows: indexedRows, query: raw });
    // "what" AND "is" AND "the" AND "database" AND "and" AND "the" AND "ORM"
    // → "what" not in indexed text → 0 results
    expect(rawResults).toHaveLength(0);

    const keywords = extractKeywords(raw);
    const expandedResults = await runSearch({
      rows: indexedRows,
      query: keywords.join(" "),
    });
    expect(expandedResults.length).toBeGreaterThan(0);
    expect(expandedResults[0]?.id).toBe("2");
  });

  it("Chinese conversational query benefits from keyword extraction", async () => {
    const rows = [
      {
        id: "zh1",
        path: "memory/zh.md",
        text: "数据库选择了 PostgreSQL，ORM 使用 Prisma",
      },
    ];
    const raw = "之前讨论的那个数据库方案";
    const rawResults = await runSearch({ rows, query: raw });

    const keywords = extractKeywords(raw);
    const expandedResults = await runSearch({
      rows,
      query: keywords.join(" "),
    });
    // Expanded query should return at least as many results as raw
    expect(expandedResults.length).toBeGreaterThanOrEqual(rawResults.length);
  });

  it("AND-joins multiple extracted keywords in hybrid mode", async () => {
    const keywords = extractKeywords("API PostgreSQL");
    expect(keywords.length).toBeGreaterThan(0);

    const results = await runSearch({
      rows: indexedRows,
      query: keywords.join(" "),
    });
    // "API" AND "PostgreSQL" — row 1 has "API" but not "PostgreSQL",
    // row 2 has "PostgreSQL" but not "API". AND semantics → 0 results.
    // This is intentional: vector search provides broad recall in hybrid mode.
    expect(results).toHaveLength(0);
  });

  it("falls back to original query when all tokens are stop words", async () => {
    const keywords = extractKeywords("what is the");
    expect(keywords).toHaveLength(0);

    // When extractKeywords returns empty, the code falls back to the raw query.
    // Verify the search doesn't throw and returns a defined result.
    const fallbackQuery = keywords.length > 0 ? keywords.join(" ") : "what is the";
    const results = await runSearch({
      rows: indexedRows,
      query: fallbackQuery,
    });
    expect(results).toBeDefined();
  });
});
