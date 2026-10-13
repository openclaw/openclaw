// Memory Core tests cover manager search plugin behavior.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchKeyword, searchKeywordWithFallback } from "./manager-search.js";
import { createMemorySearchDb, insertKeywordFixture } from "./manager-search.test-support.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    ...options,
  });
}

function supportsFts(): boolean {
  const { db, schema } = createMemorySearchDb();
  try {
    return schema.ftsAvailable;
  } finally {
    db.close();
  }
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
    { query: "42", text: "The answer is 42", unrelated: "The answer is 24" },
    { query: "C_", text: "Keep the C_ prefix", unrelated: "Keep the CA prefix" },
    { query: "ΔΕ", text: "The δε project", unrelated: "The δζ project" },
    { query: "МО", text: "The мо project", unrelated: "The ми project" },
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
  function createFtsDb() {
    const { db, schema } = createMemorySearchDb();
    if (!schema.ftsAvailable) {
      db.close();
      throw new Error(`FTS5 unavailable: ${schema.ftsError ?? "unknown error"}`);
    }
    return db;
  }

  const itWithFts = supportsFts() ? it : it.skip;

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

      vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        throw new Error("FTS5 MATCH unavailable");
      });
      const results = await searchKeywordFixture(db, "Agent", {
        sourceFilter: { sql: " AND source IN (?)", params: ["sessions"] },
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
      vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        throw new Error("FTS5 MATCH unavailable");
      });
      const results = await searchKeywordFixture(db, "Agent cron");

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

      vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        throw new Error("FTS5 MATCH unavailable");
      });
      await searchKeywordFixture(db, "test");

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

describe("searchKeyword boosted relevance", () => {
  it.each(["unicode61", "trigram"] as const)(
    "preserves %s relevance differences before dated-note decay",
    async (ftsTokenizer) => {
      const { db } = createMemorySearchDb({ ftsTokenizer });
      try {
        const notes = [
          "Quartz compass calibration: coefficient 17. Quartz compass calibration was completed, verified and approved. Record the quartz compass calibration coefficient 17 for future measurements.",
          "We discussed quartz compass calibration in planning. The next meeting will schedule a demonstration; no coefficient or measurement was recorded.",
          "The garden committee reviewed watering schedules, planted new herbs and replaced several flower pots. Volunteers will meet on Saturday to organize tools and prepare fresh soil for the spring beds.",
          "Dinner planning covered a vegetable soup, fresh bread and a fruit dessert. We compared grocery prices and agreed to prepare the meal together after shopping on Friday afternoon.",
          "The walking group selected a route through the forest and checked the weather forecast. Everyone will bring drinking water, comfortable boots and a jacket for the afternoon outing.",
        ];
        for (const [index, text] of notes.entries()) {
          insertKeywordFixture(db, {
            id: String(index),
            path: `memory/2026-10-${index === 0 ? "05" : "06"}-note-${index}.md`,
            text: `user: ${text}`,
          });
        }
        const query = "quartz compass calibration";
        const raw = await searchKeywordFixture(db, query, { ftsTokenizer });
        const boosted = await searchKeywordFixture(db, query, {
          ftsTokenizer,
          boostFallbackRanking: true,
        });
        await expect(
          searchKeywordFixture(db, `quartz quartz ${query}`, {
            ftsTokenizer,
            boostFallbackRanking: true,
          }),
        ).resolves.toEqual(boosted);
        expect(boosted.map((row) => row.id)).toEqual(["0", "1"]);
        expect(boosted.map((row) => row.textScore)).toEqual(raw.map((row) => row.textScore));
        for (const row of boosted) {
          expect(row.score).toBeGreaterThan(row.textScore);
          expect(row.score).toBeLessThan(1);
        }
        expect(boosted[0]!.score).toBeGreaterThan(boosted[1]!.score);

        const decayed = await applyTemporalDecayToHybridResults({
          results: boosted,
          temporalDecay: { enabled: true, halfLifeDays: 30 },
          nowMs: Date.UTC(2026, 9, 6),
        });
        expect(decayed[0]!.score).toBeLessThan(boosted[0]!.score);
        expect(decayed[0]!.score).toBeGreaterThan(decayed[1]!.score);
      } finally {
        db.close();
      }
    },
  );
});

describe("searchKeyword ranked limits", () => {
  it.each([
    { ftsTokenizer: "unicode61", query: "common", matchAny: false },
    { ftsTokenizer: "trigram", query: "common", matchAny: false },
    { ftsTokenizer: "trigram", query: "common UK", matchAny: true },
    { ftsTokenizer: "trigram", query: "missing UK", matchAny: true },
  ] as const)(
    "stops examining scoped candidates after filling the $ftsTokenizer result window for $query",
    async ({ ftsTokenizer, query, matchAny }) => {
      const { db } = createMemorySearchDb({ ftsTokenizer });
      try {
        for (let index = 0; index < 64; index++) {
          insertKeywordFixture(db, {
            id: `chunk-${index}`,
            path: `memory/${index}.md`,
            text: "common keyword UK",
            source: index % 2 === 0 ? "memory" : "sessions",
          });
        }
        let examined = 0;
        db.function("observe_keyword_candidate", () => {
          examined++;
          return 1;
        });
        const results = await searchKeywordFixture(db, query, {
          ftsTokenizer,
          matchAny,
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

describe("searchKeyword relaxed question ranking", () => {
  it.each(["unicode61", "trigram"] as const)(
    "keeps the answer inside a bounded %s candidate pool",
    async (ftsTokenizer) => {
      const { db } = createMemorySearchDb({ ftsTokenizer });
      try {
        for (let index = 0; index < 202; index += 1) {
          insertKeywordFixture(db, {
            id: `note-${index}`,
            path: `memory/note-${index}.md`,
            text:
              index === 0
                ? "user: Tag v0.78.42.0 is an annotated tag object 0b1698f pointing at the release commit."
                : "user: annotated tag object hash created v0",
          });
        }
        const query = "What is the annotated tag object hash created for v0.78.42.0?";
        const options = { ftsTokenizer, limit: 200, matchAny: true };
        const results = await searchKeywordFixture(db, query, options);
        expect(results).toHaveLength(200);
        expect(results[0]?.id).toBe("note-0");
        expect(results[0]?.textScore).toBeGreaterThan(results[1]?.textScore ?? 0);
        // Expansion lowercases terms; it must not add a second BM25 vote.
        await expect(searchKeywordFixture(db, query.toUpperCase(), options)).resolves.toEqual(
          results,
        );
      } finally {
        db.close();
      }
    },
  );
});

describe("searchKeyword zero-hit fallback", () => {
  it.each(["unicode61", "trigram"] as const)(
    "preserves AND precision and bounds %s retries",
    async (ftsTokenizer) => {
      const { db } = createMemorySearchDb({ ftsTokenizer });
      try {
        for (const row of [
          { id: "full", path: "memory/full.md", text: "alpha beta" },
          { id: "partial", path: "memory/partial.md", text: "alpha" },
          { id: "path", path: "memory/exact.md", text: "unrelated" },
          { id: "dotted", path: "memory/dotted.md", text: "i\u0307" },
        ]) {
          insertKeywordFixture(db, row);
        }
        const prepare = vi.spyOn(db, "prepare");
        const search = (query: string) =>
          searchKeywordWithFallback({
            db,
            body: {
              query,
              ftsTokenizer,
              ftsTable: "memory_index_chunks_fts",
              limit: 10,
              snippetMaxChars: 200,
              sourceFilter: { sql: "", params: [] },
            },
            path: {
              query,
              ftsTokenizer,
              pathFtsTable: "memory_index_paths_fts",
              limit: 10,
              snippetMaxChars: 200,
              sourceFilter: { sql: "", params: [] },
            },
          });
        const bodyQueries = () =>
          prepare.mock.calls.filter(([sql]) => /FROM memory_index_chunks_fts\b/.test(sql)).length;

        expect((await search("alpha beta")).body.rows.map((row) => row.id)).toEqual(["full"]);
        expect(bodyQueries()).toBe(1);
        prepare.mockClear();
        const exact = await search("exact.md");
        expect(exact.body.rows).toEqual([]);
        expect(exact.path.rows.map((row) => row.id)).toEqual(["path"]);
        expect(bodyQueries()).toBe(1);
        prepare.mockClear();
        const relaxed = await search("alpha beta missing");
        expect(relaxed.body.error).toBeUndefined();
        expect(relaxed.body.rows.map((row) => row.id).toSorted()).toEqual(["full", "partial"]);
        expect(bodyQueries()).toBe(2);
        prepare.mockClear();
        expect((await search("İ missing")).body.rows.map((row) => row.id)).toEqual(["dotted"]);
      } finally {
        db.close();
      }
    },
  );

  it("combines canonical MATCH and short trigram OR terms without scoring substring-only hits", async () => {
    const { db } = createMemorySearchDb({ ftsTokenizer: "trigram" });
    try {
      for (const row of [
        { id: "long", path: "memory/long.md", text: "cafe\u0301" },
        { id: "short", path: "memory/short.md", text: "uk plans" },
        { id: "other", path: "memory/other.md", text: "unrelated" },
      ]) {
        insertKeywordFixture(db, row);
      }
      insertKeywordFixture(db, {
        id: "hidden",
        path: "sessions/hidden.md",
        text: "café UK",
        source: "sessions",
      });
      const results = await searchKeywordFixture(db, "café UK", {
        ftsTokenizer: "trigram",
        matchAny: true,
        sourceFilter: { sql: " AND source = ?", params: ["memory"] },
      });
      expect(results.map((row) => row.id)).toEqual(["long", "short"]);
      expect(results[0]?.textScore).toBeGreaterThan(0);
      expect(results[1]?.textScore).toBe(0);
    } finally {
      db.close();
    }
  });
});
