import { afterEach, expect, it, vi } from "vitest";
import { createKeywordSearch } from "./manager-keyword-fixture.test-support.js";
import { searchKeywordWithFallback } from "./manager-search.js";
import { createMemorySearchDb, insertKeywordFixture } from "./manager-search.test-support.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function supportsFts(ftsTokenizer: "unicode61" | "trigram" = "unicode61"): boolean {
  const { db, schema } = createMemorySearchDb({ ftsTokenizer });
  try {
    return schema.ftsAvailable;
  } finally {
    db.close();
  }
}

const itWithTrigramFts = supportsFts("trigram") ? it : it.skip;

itWithTrigramFts("applies fallback lexical boosts without exceeding bounded scores", async () => {
  const { db, search } = createKeywordSearch("trigram");
  const rows = [
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
  ];
  for (const row of rows) {
    insertKeywordFixture(db, { ...row, endLine: 1 });
  }
  const query = "project memory context";
  const results = await search(query, { boostFallbackRanking: true });
  expect(results.map((row) => row.id)).toEqual(["weak", "strong"]);
  const rawResults = await search(query, { boostFallbackRanking: false });

  const boostedById = new Map(results.map((row) => [row.id, row]));
  const rawById = new Map(rawResults.map((row) => [row.id, row]));
  expect(rawById.get("strong")?.textScore).toBeLessThan(rawById.get("weak")?.textScore ?? 0);
  expect(boostedById.get("strong")?.score).toBeGreaterThan(boostedById.get("weak")?.score ?? 0);
  expect(boostedById.get("strong")?.textScore).toBe(rawById.get("strong")?.textScore);
  expect(boostedById.get("weak")?.textScore).toBe(rawById.get("weak")?.textScore);
  expect(boostedById.get("strong")?.score).toBeLessThanOrEqual(1);
  expect(boostedById.get("weak")?.score).toBeLessThanOrEqual(1);
});
it("preserves unicode61 relevance differences before dated-note decay", async () => {
  const { db, search } = createKeywordSearch();
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
  const raw = await search(query);
  const boosted = await search(query, {
    boostFallbackRanking: true,
  });
  await expect(
    search(`quartz quartz ${query}`, {
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
});
const itWithFts = supportsFts() ? it : it.skip;

itWithFts("returns FTS hits indexed under a different embedding model", async () => {
  const { db, search } = createKeywordSearch();
  for (const [id, model] of [
    ["clyde-old", "bge-m3"],
    ["clyde-new", "nomic-embed-text"],
  ] as const) {
    insertKeywordFixture(db, {
      text: "Persona notes for Clyde the assistant",
      id,
      model,
      path: "memory/persona.md",
      endLine: 3,
    });
  }
  const results = await search("Clyde");

  expect(results.map((row) => row.id).toSorted()).toEqual(["clyde-new", "clyde-old"]);
});

itWithFts("does not return orphaned old-model FTS rows without a live chunk", async () => {
  const { db, search } = createKeywordSearch();
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

  const results = await search("Clyde");

  expect(results.map((row) => row.id)).toEqual(["live-clyde"]);
});
it("keeps the answer inside a bounded unicode61 candidate pool", async () => {
  const { db, search } = createKeywordSearch();
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
  const options = { limit: 200, matchAny: true };
  const results = await search(query, options);
  expect(results).toHaveLength(200);
  expect(results[0]?.id).toBe("note-0");
  expect(results[0]?.textScore).toBeGreaterThan(results[1]?.textScore ?? 0);
  // Expansion lowercases terms; it must not add a second BM25 vote.
  await expect(search(query.toUpperCase(), options)).resolves.toEqual(results);
});
it.each(["unicode61", "trigram"] as const)(
  "preserves AND precision and bounds %s retries",
  async (ftsTokenizer) => {
    const { db } = createKeywordSearch(ftsTokenizer);
    for (const row of [
      { id: "full", path: "memory/full.md", text: "alpha beta" },
      { id: "partial", path: "memory/partial.md", text: "alpha" },
      { id: "path", path: "memory/exact.md", text: "unrelated" },
      { id: "dotted", path: "memory/dotted.md", text: "i\u0307" },
    ]) {
      insertKeywordFixture(db, row);
    }
    const prepare = vi.spyOn(db, "prepare");
    const search = (query: string) => {
      const options = {
        query,
        ftsTokenizer,
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
      };
      return searchKeywordWithFallback({
        db,
        body: { ...options, ftsTable: "memory_index_chunks_fts" },
        path: { ...options, pathFtsTable: "memory_index_paths_fts" },
      });
    };
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
  },
);
