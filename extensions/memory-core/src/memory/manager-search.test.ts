// Memory Core tests cover manager search plugin behavior.
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./keyword-query.js";
import { searchKeyword } from "./manager-search.js";
import { createMemorySearchDb, insertKeywordFixture } from "./manager-search.test-support.js";

type KeywordSearchOptions = Omit<Parameters<typeof searchKeyword>[0], "db" | "query">;

function searchKeywordFixture(
  db: DatabaseSync,
  query: string,
  options: Partial<KeywordSearchOptions> = {},
) {
  return searchKeyword({
    db,
    ftsTable: "memory_index_chunks_fts",
    query,
    ftsTokenizer: "unicode61",
    limit: 10,
    snippetMaxChars: 200,
    sourceFilter: { sql: "", params: [] },
    buildFtsQuery,
    bm25RankToScore,
    ...options,
  });
}

describe("searchKeyword trigram fallback", () => {
  function supportsTrigramFts(): boolean {
    const { db, schema } = createMemorySearchDb({ ftsTokenizer: "trigram" });
    try {
      return schema.ftsAvailable;
    } finally {
      db.close();
    }
  }

  function createTrigramDb() {
    const { db, schema } = createMemorySearchDb({ ftsTokenizer: "trigram" });
    if (!schema.ftsAvailable) {
      db.close();
      throw new Error(`FTS5 trigram unavailable: ${schema.ftsError ?? "unknown error"}`);
    }
    return db;
  }

  async function runSearch(params: {
    rows: Array<{ id: string; path: string; text: string }>;
    query: string;
    boostFallbackRanking?: boolean;
  }) {
    const db = createTrigramDb();
    try {
      for (const row of params.rows) {
        insertKeywordFixture(db, {
          text: row.text,
          id: row.id,
          path: row.path,
          endLine: 1,
        });
      }
      return await searchKeywordFixture(db, params.query, {
        ftsTokenizer: "trigram",
        boostFallbackRanking: params.boostFallbackRanking,
      });
    } finally {
      db.close();
    }
  }

  const itWithTrigramFts = supportsTrigramFts() ? it : it.skip;

  itWithTrigramFts.each([
    { query: "成语", text: "今天玩成语接龙游戏", unrelated: "今天看电影" },
    { query: "AI", text: "Use ai for classification", unrelated: "Use rules for classification" },
    { query: "UK", text: "Ship to the uk", unrelated: "Ship to the EU" },
    { query: "42", text: "The answer is 42", unrelated: "The answer is 24" },
    { query: "C_", text: "Keep the C_ prefix", unrelated: "Keep the CA prefix" },
    { query: "ΔΕ", text: "The δε project", unrelated: "The δζ project" },
    { query: "МО", text: "The мо project", unrelated: "The ми project" },
    { query: "ΟΣ", text: "The οσ project", unrelated: "The οτ project" },
    { query: "Σ", text: "ς", unrelated: "τ" },
    { query: "S", text: "ſ", unrelated: "z" },
    { query: "K", text: "K", unrelated: "q" },
    { query: "Ǆ", text: "ǅ", unrelated: "ǈ" },
  ])(
    "finds the short literal query $query with substring fallback",
    async ({ query, text, unrelated }) => {
      const results = await runSearch({
        rows: [
          { id: "match", path: "memory/match.md", text },
          { id: "unrelated", path: "memory/unrelated.md", text: unrelated },
        ],
        query,
      });
      expect(results.map((row) => row.id)).toEqual(["match"]);
      // LIKE substring fallback carries no BM25 ranking signal, so textScore is 0
      // (recall only); the hybrid merge must not treat it as a perfect match.
      expect(results[0]?.textScore).toBe(0);
      expect(results[0]?.hasBodyMatch).toBe(true);
    },
  );

  itWithTrigramFts("finds short Japanese and Korean queries with substring fallback", async () => {
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

  itWithTrigramFts.each([
    {
      query: "成语接龙 游戏",
      match: "今天玩成语接龙游戏",
      partial: "今天玩成语接龙",
      short: "游戏",
    },
    {
      query: "shipping UK",
      match: "Shipping across the UK",
      partial: "Shipping across the EU",
      short: "UK office",
    },
    {
      query: "shipping ΔΕ",
      match: "Shipping for the δε project",
      partial: "Shipping for the δζ project",
      short: "δε office",
    },
    {
      query: "shipping ΟΣ",
      match: "Shipping for the οσ project",
      partial: "Shipping for the οτ project",
      short: "οσ office",
    },
  ])(
    "keeps MATCH semantics while requiring every term in $query",
    async ({ query, match, partial, short }) => {
      const results = await runSearch({
        rows: [
          { id: "match", path: "memory/good.md", text: match },
          { id: "partial", path: "memory/partial.md", text: partial },
          { id: "short", path: "memory/short.md", text: short },
        ],
        query,
      });
      expect(results.map((row) => row.id)).toEqual(["match"]);
      expect(results[0]?.textScore).toBeGreaterThan(0);
    },
  );

  itWithTrigramFts("applies fallback lexical boosts without exceeding bounded scores", async () => {
    const results = await runSearch({
      rows: [
        {
          id: "strong",
          path: "memory/project-memory-notes.md",
          text: "Project memory notes covering workspace context and retrieval behavior.",
        },
        {
          id: "weak",
          path: "memory/notes.md",
          text: "Project memory context.",
        },
      ],
      query: "project memory context",
      boostFallbackRanking: true,
    });
    expect(results.map((row) => row.id)).toEqual(["weak", "strong"]);
    const rawResults = await runSearch({
      rows: [
        {
          id: "strong",
          path: "memory/project-memory-notes.md",
          text: "Project memory notes covering workspace context and retrieval behavior.",
        },
        {
          id: "weak",
          path: "memory/notes.md",
          text: "Project memory context.",
        },
      ],
      query: "project memory context",
      boostFallbackRanking: false,
    });

    const boostedById = new Map(results.map((row) => [row.id, row]));
    const rawById = new Map(rawResults.map((row) => [row.id, row]));
    expect(rawById.get("strong")?.textScore).toBeLessThan(rawById.get("weak")?.textScore ?? 0);
    expect(boostedById.get("strong")?.score).toBeGreaterThan(boostedById.get("weak")?.score ?? 0);
    expect(boostedById.get("strong")?.textScore).toBe(rawById.get("strong")?.textScore);
    expect(boostedById.get("weak")?.textScore).toBe(rawById.get("weak")?.textScore);
    expect(boostedById.get("strong")?.score).toBeLessThanOrEqual(1);
    expect(boostedById.get("weak")?.score).toBeLessThanOrEqual(1);
  });

  itWithTrigramFts("does not overweight repeated query tokens in fallback scoring", async () => {
    const unique = await runSearch({
      rows: [{ id: "1", path: "memory/project.md", text: "Project memory context." }],
      query: "project memory context",
      boostFallbackRanking: true,
    });
    const repeated = await runSearch({
      rows: [{ id: "1", path: "memory/project.md", text: "Project memory context." }],
      query: "project project project memory context",
      boostFallbackRanking: true,
    });

    expect(repeated[0]?.score).toBe(unique[0]?.score);
  });
});

describe("searchKeyword FTS MATCH fallback", () => {
  function supportsFts(): boolean {
    const { db, schema } = createMemorySearchDb();
    try {
      return schema.ftsAvailable;
    } finally {
      db.close();
    }
  }

  function createFtsDb() {
    const { db, schema } = createMemorySearchDb();
    if (!schema.ftsAvailable) {
      db.close();
      throw new Error(`FTS5 unavailable: ${schema.ftsError ?? "unknown error"}`);
    }
    return db;
  }

  const itWithFts = supportsFts() ? it : it.skip;

  itWithFts("falls back to LIKE search when FTS MATCH throws", async () => {
    const db = createFtsDb();
    try {
      insertKeywordFixture(db, {
        text: "The Agent framework handles API calls and cron jobs",
        id: "1",
        path: "doc.md",
        source: "sessions",
        endLine: 5,
      });
      insertKeywordFixture(db, {
        text: "Deploy the database cluster on Hetzner",
        id: "2",
        path: "ops.md",
        source: "sessions",
        endLine: 3,
      });

      // Simulate a buildFtsQuery that produces a broken MATCH expression
      const brokenBuildFtsQuery = () => "BROKEN_QUERY_SYNTAX <<<";

      const results = await searchKeywordFixture(db, "Agent", {
        buildFtsQuery: brokenBuildFtsQuery,
      });

      // LIKE fallback should find "Agent" in the first row
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.id).toBe("1");
      // LIKE fallback has no BM25 ranking, so textScore is 0 (recall only) and
      // cannot inflate the hybrid merge into a spurious finalScore = 1.0.
      expect(results[0]?.textScore).toBe(0);
      expect(results[0]?.hasBodyMatch).toBe(true);
    } finally {
      db.close();
    }
  });

  itWithFts("returns BM25-scored results when FTS MATCH succeeds", async () => {
    const db = createFtsDb();
    try {
      insertKeywordFixture(db, {
        text: "The Transformer architecture powers modern LLMs",
        id: "1",
        path: "ml.md",
        endLine: 3,
      });

      const results = await searchKeywordFixture(db, "Transformer");

      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe("1");
      // BM25 score should be a real computed value, not the fallback default
      expect(results[0]?.textScore).toBeGreaterThan(0);
      expect(results[0]?.textScore).toBeLessThan(1);
    } finally {
      db.close();
    }
  });

  itWithFts("applies source filter in LIKE fallback", async () => {
    const db = createFtsDb();
    try {
      insertKeywordFixture(db, {
        text: "Agent handles API calls",
        id: "1",
        path: "doc.md",
        source: "sessions",
        endLine: 3,
      });
      insertKeywordFixture(db, {
        text: "Agent design patterns",
        id: "2",
        path: "notes.md",
        endLine: 3,
      });

      const brokenBuildFtsQuery = () => "BROKEN <<<";
      const results = await searchKeywordFixture(db, "Agent", {
        sourceFilter: { sql: " AND source IN (?)", params: ["sessions"] },
        buildFtsQuery: brokenBuildFtsQuery,
      });

      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe("1");
      expect(results[0]?.source).toBe("sessions");
    } finally {
      db.close();
    }
  });

  itWithFts("splits multi-word query into per-token LIKE clauses in fallback", async () => {
    const db = createFtsDb();
    try {
      // "Agent" and "cron" appear in this row but not adjacent
      insertKeywordFixture(db, {
        text: "The Agent framework handles API calls and cron jobs",
        id: "1",
        path: "doc.md",
        source: "sessions",
        endLine: 5,
      });
      // Only "Agent" appears in this row
      insertKeywordFixture(db, {
        text: "Agent design patterns for microservices",
        id: "2",
        path: "arch.md",
        source: "sessions",
        endLine: 3,
      });

      // A single-substring LIKE '%Agent cron%' would miss row 1 because
      // the words are not adjacent. Per-token LIKE should find it.
      const brokenBuildFtsQuery = () => "BROKEN <<<";
      const results = await searchKeywordFixture(db, "Agent cron", {
        buildFtsQuery: brokenBuildFtsQuery,
      });

      // Per-token fallback: both "Agent" AND "cron" must match
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe("1");
    } finally {
      db.close();
    }
  });

  itWithFts("logs warning when MATCH fallback is used", async () => {
    const db = createFtsDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      insertKeywordFixture(db, {
        text: "test content",
        id: "1",
        path: "doc.md",
        source: "sessions",
        endLine: 1,
      });

      await searchKeywordFixture(db, "test", {
        buildFtsQuery: () => "BROKEN <<<",
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warning] = warnSpy.mock.calls[0] ?? [];
      expect(typeof warning).toBe("string");
      expect(
        (warning as string | undefined)?.startsWith(
          "memory search: FTS5 MATCH failed, falling back to substring search: ",
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      db.close();
    }
  });
});

describe("searchKeyword ranked limits", () => {
  it.each(["unicode61", "trigram"] as const)(
    "stops examining scoped candidates after filling the %s result window",
    async (ftsTokenizer) => {
      const { db } = createMemorySearchDb({ ftsTokenizer });
      try {
        for (let index = 0; index < 64; index++) {
          insertKeywordFixture(db, {
            id: `chunk-${index}`,
            path: `memory/${index}.md`,
            text: "common keyword",
            source: index % 2 === 0 ? "memory" : "sessions",
          });
        }
        let examined = 0;
        db.function("observe_keyword_candidate", () => {
          examined++;
          return 1;
        });
        const results = await searchKeywordFixture(db, "common", {
          ftsTokenizer,
          limit: 3,
          sourceFilter: {
            sql: " AND source IN (?) AND observe_keyword_candidate() = 1",
            params: ["sessions"],
          },
        });
        expect(results.map((row) => row.id)).toEqual(["chunk-1", "chunk-3", "chunk-5"]);
        expect(examined).toBeLessThanOrEqual(6);
      } finally {
        db.close();
      }
    },
  );

  it("preserves default BM25 scores without changing a configured rank mapping", async () => {
    const { db } = createMemorySearchDb();
    try {
      insertKeywordFixture(db, {
        id: "weak",
        path: "memory/weak.md",
        text: "common " + "unrelated ".repeat(20),
      });
      insertKeywordFixture(db, {
        id: "strong",
        path: "memory/strong.md",
        text: "common common common",
      });
      const expected = await searchKeywordFixture(db, "common");
      expect(expected.map((row) => row.id)).toEqual(["strong", "weak"]);
      db.prepare(
        "INSERT INTO memory_index_chunks_fts(memory_index_chunks_fts, rank) VALUES ('rank', 'bm25(0.0)')",
      ).run();

      await expect(searchKeywordFixture(db, "common")).resolves.toEqual(expected);
      expect(
        db
          .prepare("SELECT rank FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
          .all("common")
          .map((row) => row.rank),
      ).toEqual([-0, -0]);
    } finally {
      db.close();
    }
  });
});

describe("searchKeyword cross-model FTS visibility (issue #48300)", () => {
  function supportsFts(): boolean {
    const { db, schema } = createMemorySearchDb();
    try {
      return schema.ftsAvailable;
    } finally {
      db.close();
    }
  }

  const itWithFts = supportsFts() ? it : it.skip;

  itWithFts("returns FTS hits indexed under a different embedding model", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      insertKeywordFixture(db, {
        text: "Persona notes for Clyde the assistant",
        id: "clyde-old",
        path: "memory/persona.md",
        model: "bge-m3",
        endLine: 3,
      });
      insertKeywordFixture(db, {
        text: "Persona notes for Clyde the assistant",
        id: "clyde-new",
        path: "memory/persona.md",
        model: "nomic-embed-text",
        endLine: 3,
      });

      const results = await searchKeywordFixture(db, "Clyde");

      expect(results.map((row) => row.id).toSorted()).toEqual(["clyde-new", "clyde-old"]);
    } finally {
      db.close();
    }
  });

  itWithFts("does not return orphaned old-model FTS rows without a live chunk", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      insertKeywordFixture(db, {
        text: "Current Clyde notes",
        id: "live-clyde",
        path: "memory/persona.md",
        model: "nomic-embed-text",
        endLine: 3,
      });
      db.prepare(
        "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "Deleted Clyde notes from an older model",
        "orphan-clyde",
        "memory/persona.md",
        "memory",
        "bge-m3",
        1,
        3,
      );

      const results = await searchKeywordFixture(db, "Clyde");

      expect(results.map((row) => row.id)).toEqual(["live-clyde"]);
    } finally {
      db.close();
    }
  });
});
