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
});

describe("searchKeyword boosted relevance", () => {
  it.each(["unicode61"] as const)(
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
  it.each(["unicode61"] as const)(
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
});
