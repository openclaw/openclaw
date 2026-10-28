import { INVALID_PROJECT_ANNOTATION_KEY } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  mergeHybridResults,
  scoreExactPathTieForTemporalDecay,
  selectHybridSearchResults,
} from "./hybrid.js";
import { bm25RankToScore } from "./keyword-query.js";

type HybridInputs = Parameters<typeof mergeHybridResults>[0];
type VectorHit = HybridInputs["vector"][number];
type KeywordHit = HybridInputs["keyword"][number];

const merge = (inputs: Partial<HybridInputs>) =>
  mergeHybridResults({
    vector: [],
    keyword: [],
    vectorWeight: 0.7,
    textWeight: 0.3,
    mmr: { enabled: false, lambda: 0.7 },
    temporalDecay: { enabled: false, halfLifeDays: 30 },
    ...inputs,
  });

function hit(id: string) {
  return {
    id,
    path: `memory/${id}.md`,
    startLine: 1,
    endLine: 2,
    source: "memory",
    snippet: id,
  };
}

function vectorHit(id: string, vectorScore: number, details: Partial<VectorHit> = {}): VectorHit {
  return { ...hit(id), vectorScore, ...details };
}

function keywordHit(id: string, textScore: number, details: Partial<KeywordHit> = {}): KeywordHit {
  return { ...hit(id), textScore, ...details };
}

const vectorOnly = { vectorWeight: 1, textWeight: 0 };
const equallyWeighted = { vectorWeight: 1, textWeight: 1 };
const expectPaths = (results: { path: string }[], ...names: string[]) =>
  expect(results.map((entry) => entry.path)).toEqual(names.map((name) => `memory/${name}.md`));
const exactKeyword = (id: string, textScore: number, name: string, pathScore = 0) =>
  keywordHit(id, textScore, { path: `memory/${name}.md`, exactPathSpecificity: 2, pathScore });
const exactVector = (id: string, vectorScore: number, name: string) =>
  vectorHit(id, vectorScore, { path: `memory/${name}.md`, exactPathSpecificity: 2 });
const select = (
  merged: Awaited<ReturnType<typeof merge>>,
  keyword: KeywordHit[],
  vectorCandidates: VectorHit[],
  maxResults = 2,
  minScore = 0.35,
) => selectHybridSearchResults({ merged, keyword, vectorCandidates, maxResults, minScore });

describe("memory hybrid helpers", () => {
  it("sorts private ranking tiers without copying them or mutating inputs", async () => {
    const keyword = [0, 1, 2, 3].flatMap((specificity) =>
      ["z", "a"].map((name) =>
        keywordHit(`${specificity}-${name}`, 0.5, {
          exactPathSpecificity: specificity as 0 | 1 | 2 | 3,
        }),
      ),
    );
    const before = structuredClone(keyword);
    keyword.forEach(Object.freeze);
    Object.freeze(keyword);
    const copies = vi.spyOn(Array.prototype, "toSorted");
    let copyCount: number;
    let result: Awaited<ReturnType<typeof merge>>;
    try {
      result = await merge({ keyword });
      copyCount = copies.mock.calls.length;
    } finally {
      copies.mockRestore();
    }
    expectPaths(result, "3-a", "3-z", "2-a", "2-z", "1-a", "1-z", "0-a", "0-z");
    expect(keyword).toEqual(before);
    expect(copyCount).toBe(0);
  });

  it("bm25RankToScore is monotonic and clamped", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(-100)).toBeCloseTo(1, 1);
  });

  it("bm25RankToScore preserves FTS5 BM25 relevance ordering", () => {
    const strongest = bm25RankToScore(-4.2);
    const middle = bm25RankToScore(-2.1);
    const weakest = bm25RankToScore(-0.5);

    expect(strongest).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(weakest);
  });

  it("bounds temporal exact-path tie scores to the identity and content bands", () => {
    expect(scoreExactPathTieForTemporalDecay(-1)).toBe(0.5);
    expect(scoreExactPathTieForTemporalDecay(0)).toBe(0.5);
    expect(scoreExactPathTieForTemporalDecay(0.5)).toBe(0.75);
    expect(scoreExactPathTieForTemporalDecay(2)).toBe(1);
  });

  it("does not let MMR-ranked keyword-only hits displace strict results", async () => {
    const keyword = keywordHit("keyword", 1, {
      path: "memory/keyword-first.md",
      endLine: 1,
      snippet: "unrelated lexical topic",
    });
    const vector = [
      vectorHit("strict-first", 1, { endLine: 1, snippet: "shared semantic topic" }),
      vectorHit("strict-later", 0.9, { endLine: 1, snippet: "shared semantic topic" }),
    ];
    const merged = await merge({
      mmr: { enabled: true, lambda: 0.2 },
      vector,
      keyword: [keyword],
    });
    expectPaths(merged, "strict-first", "keyword-first", "strict-later");
    expectPaths(select(merged, [keyword], vector), "strict-first", "strict-later");
  });

  it("keeps relevant old notes eligible through decay and MMR", async () => {
    const oldPath = "memory/records/2026-08-11-quartz.md";
    const vector = [
      vectorHit("old", 0.9, { path: oldPath }),
      vectorHit("recent", 0.9, { path: "memory/records/2026-10-10-quartz.md" }),
      vectorHit("evergreen", 0.8),
      vectorHit("weak", 0.2),
    ];
    const keyword = [keywordHit("old", 0.8, { path: oldPath })];
    const merged = await merge({
      vector,
      keyword,
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      mmr: { enabled: true, lambda: 0.7 },
      nowMs: Date.UTC(2026, 9, 10),
    });
    const selected = select(merged, keyword, vector, 4);
    expectPaths(selected, "records/2026-10-10-quartz", "evergreen", "records/2026-08-11-quartz");
    expect(selected[2]?.score).toBeCloseTo(0.2175);
    expect(selected[2]?.vectorScore).toBe(0.9);
    expect(selected[2]?.textScore).toBe(0.8);
  });

  it.each([
    { vectorScore: -0.5, expectedPaths: ["memory/strict.md"] },
    { vectorScore: 0, expectedPaths: ["memory/strict.md", "memory/keyword.md"] },
    { vectorScore: 0.2, expectedPaths: ["memory/strict.md", "memory/keyword.md"] },
  ])(
    "fills lexical spare slots only with nonnegative completed scores ($vectorScore)",
    async ({ vectorScore, expectedPaths }) => {
      const vectorCandidates = [vectorHit("strict", 1)];
      const keyword = [keywordHit("keyword", 0, { hasBodyMatch: true, rankingScore: 0.8 })];
      const merged = await merge({
        vector: [...vectorCandidates, vectorHit("keyword", vectorScore)],
        keyword,
      });

      expect(select(merged, keyword, vectorCandidates).map((entry) => entry.path)).toEqual(
        expectedPaths,
      );
    },
  );

  it("puts keyword scores on the vector scale before weighting them", async () => {
    const merged = await merge({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        vectorHit("closer-meaning", 0.55),
        vectorHit("weak-keyword-a", 0.5),
        vectorHit("weak-keyword-b", 0.48),
        // Completed stored scores for keyword candidates outside the vector window.
        vectorHit("full-query", 0.45),
        vectorHit("partial-path", 0.2),
        vectorHit("excluded", 0.9, { projectKey: INVALID_PROJECT_ANNOTATION_KEY }),
      ],
      keyword: [
        keywordHit("full-query", 0.9, { rankingScore: 0.95 }),
        keywordHit("weak-keyword-a", 0.5, { rankingScore: 0.75 }),
        keywordHit("weak-keyword-b", 0.45, { rankingScore: 0.7 }),
        // SQLite's path substring fallback reports 1 without a rank.
        keywordHit("partial-path", 0, { pathScore: 1 }),
        // Malformed project annotations never reach results.
        keywordHit("excluded", 0.95, {
          rankingScore: 0.99,
          projectKey: INVALID_PROJECT_ANNOTATION_KEY,
        }),
      ],
    });

    // Weak keyword matches rank below a closer meaning, and the strongest keyword
    // match (or an unranked one) earns up to the best returned vector score.
    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/full-query.md",
      "memory/closer-meaning.md",
      "memory/weak-keyword-a.md",
      "memory/weak-keyword-b.md",
      "memory/partial-path.md",
    ]);
    expect(merged[0]?.score).toBeCloseTo(0.7 * 0.45 + 0.3 * 0.55);
    expect(merged[1]?.score).toBeCloseTo(0.7 * 0.55);
    expect(merged[2]?.textScore).toBe(0.5);
    expect(merged[4]?.score).toBeCloseTo(0.7 * 0.2 + 0.3 * 0.55);
  });

  it("keeps null importance neutral and deterministically boosts important entries", async () => {
    for (const [importance, expected] of [
      [undefined, 0.8],
      [10, 1],
      [1, 0.64],
    ] as const) {
      const results = await merge({
        ...vectorOnly,
        vector: [vectorHit("entry", 0.8, { path: "MEMORY.md", endLine: 1, importance })],
      });
      expect(results[0]?.score).toBeCloseTo(expected);
    }
  });

  it("uses path BM25 only for partial path-only hybrid hits", async () => {
    const merged = await merge({
      keyword: [
        keywordHit("partial-path", 0, {
          path: "memory/project-lantern-notes.md",
          snippet: "unrelated body",
          pathScore: 0.8,
        }),
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.score).toBeCloseTo(0.3 * 0.8);
    expect(merged[0]?.textScore).toBe(0);
  });

  it("lets a fresh path-only exact hit beat stale content-backed retrieval", async () => {
    const merged = await merge({
      nowMs: Date.UTC(2026, 6, 11),
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      vector: [
        vectorHit("stale", 1, {
          path: "memory/2020-01-01.md",
          snippet: "stale content-backed body",
          exactPathSpecificity: 1,
        }),
      ],
      keyword: [
        keywordHit("stale", 0, {
          path: "memory/2020-01-01.md",
          snippet: "unrelated stale body",
          pathScore: 1,
          exactPathSpecificity: 1,
        }),
        keywordHit("fresh", 0, {
          path: "memory/2026-07-10.md",
          snippet: "unrelated fresh body",
          pathScore: 0.01,
          exactPathSpecificity: 1,
        }),
      ],
    });

    expectPaths(merged, "2026-07-10", "2020-01-01");
    expect(merged.map((entry) => entry.score)).toEqual([1, 1]);
    expect(merged.every((entry) => entry.textScore === 0)).toBe(true);
  });

  it("ignores zero-weight and non-positive content when ordering exact hybrid hits", async () => {
    const merged = await merge({
      ...vectorOnly,
      vector: [exactVector("vector", -1, "z/foo")],
      keyword: [exactKeyword("body", 1, "y/foo"), exactKeyword("path", 0, "a/foo", 1)],
    });

    expectPaths(merged, "a/foo", "y/foo", "z/foo");
  });

  it("keeps the full content-backed exact group ahead of path-only hits through MMR", async () => {
    const merged = await merge({
      vectorWeight: 0,
      textWeight: 1,
      mmr: { enabled: true, lambda: 0.5 },
      keyword: [
        keywordHit("body", 0.1, {
          path: "memory/z/foo.md",
          snippet: "body-backed result",
          exactPathSpecificity: 2,
        }),
        keywordHit("body-secondary", 0.05, {
          path: "memory/y/foo.md",
          snippet: "body-backed result",
          exactPathSpecificity: 2,
        }),
        keywordHit("path", 0, {
          path: "memory/a/foo.md",
          snippet: "path-only result",
          pathScore: 1,
          exactPathSpecificity: 2,
        }),
      ],
    });

    expectPaths(merged, "z/foo", "y/foo", "a/foo");
  });

  it("uses specificity across exact tiers and combined relevance within one tier", async () => {
    const merged = await merge({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        vectorHit("full", 0),
        vectorHit("basename-weak", 0.2, { path: "memory/a/foo.md", snippet: "basename weak" }),
        vectorHit("basename-strong", 0.9, { path: "memory/z/foo.md", snippet: "basename strong" }),
        exactVector("exact-vector", 0.4, "deep/README"),
        exactVector("cancelled", -1, "z-cancel/foo"),
        vectorHit("stem", 1, { path: "memory/foo.md.bak" }),
        vectorHit("semantic", 0.99),
      ],
      keyword: [
        keywordHit("full", 0, { exactPathSpecificity: 3 }),
        exactKeyword("basename-weak", 0.1, "a/foo", 1),
        exactKeyword("basename-path-only", 0, "0/foo", 1),
        exactKeyword("basename-strong", 0.8, "z/foo", 0.01),
        exactKeyword("cancelled", 0.5, "z-cancel/foo"),
        keywordHit("stem", 1, { path: "memory/foo.md.bak", exactPathSpecificity: 1 }),
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/full.md",
      "memory/z/foo.md",
      "memory/deep/README.md",
      "memory/a/foo.md",
      "memory/0/foo.md",
      "memory/z-cancel/foo.md",
      "memory/foo.md.bak",
      "memory/semantic.md",
    ]);
    expect(merged.map((entry) => entry.score)).toEqual([1, 1, 1, 1, 1, 1, 1, 0.495]);
    expect(merged[2]?.vectorScore).toBe(0.4);
  });

  it("keeps exact path identifiers ahead after decay, oversized weights, and MMR", async () => {
    const merged = await merge({
      ...equallyWeighted,
      nowMs: Date.UTC(2026, 6, 11),
      temporalDecay: { enabled: true, halfLifeDays: 1 },
      mmr: { enabled: true, lambda: 0.5 },
      vector: [vectorHit("semantic", 1, { snippet: "semantic neighbor" })],
      keyword: [
        keywordHit("semantic", 1, { snippet: "semantic neighbor" }),
        keywordHit("exact-path", 0.01, {
          path: "memory/2020-01-01.md",
          snippet: "dated exact path",
          exactPathSpecificity: 1,
        }),
      ],
    });

    expectPaths(merged, "2020-01-01", "semantic");
    expect(merged[0]?.score).toBe(1);
    expect(merged[1]?.score).toBe(2);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", async () => {
    const merged = await merge({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [vectorHit("a", 0.2, { snippet: "vec-a" })],
      keyword: [keywordHit("a", 1, { snippet: "kw-a" })],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    // Keyword credit is capped at the best vector score.
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 0.2);
    expect(merged[0]?.vectorScore).toBeCloseTo(0.2);
    expect(merged[0]?.textScore).toBeCloseTo(1);
  });

  it.each([null, 0.5, -0.5])(
    "preserves LIKE lexical ties and public confidence with vector score %s",
    async (vectorScore) => {
      const keyword = [
        { id: "aaa", rankingScore: 0.2 },
        { id: "zzz", rankingScore: 0.8 },
      ].map(({ id, rankingScore }) =>
        keywordHit(id, 0, {
          endLine: 1,
          snippet: `${id} substring overlap`,
          hasBodyMatch: true,
          rankingScore,
          pathScore: 0,
          exactPathSpecificity: 0,
        }),
      );
      const merged = await merge({
        vector: vectorScore === null ? [] : keyword.map((entry) => ({ ...entry, vectorScore })),
        keyword,
      });

      // LIKE strength breaks tied confidence without turning recall into a scored match.
      expect(merged.map((entry) => entry.path)).toEqual(["memory/zzz.md", "memory/aaa.md"]);
      expect(merged).toEqual(
        Array.from({ length: 2 }, () =>
          expect.objectContaining({
            score: (vectorScore ?? 0) * 0.7,
            vectorScore: vectorScore ?? 0,
            textScore: 0,
          }),
        ),
      );
      expect(merged.every((entry) => !("lexicalRank" in entry) && !("rankingScore" in entry))).toBe(
        true,
      );
      const selected = selectHybridSearchResults({
        merged,
        keyword,
        vectorCandidates: vectorScore === null ? [] : keyword,
        maxResults: 2,
        minScore: 0.35,
      });
      expect(selected).toEqual(
        vectorScore !== null && vectorScore < 0
          ? []
          : merged.map(({ eligibilityScore: _eligibilityScore, ...entry }) => entry),
      );
    },
  );

  const vectorResult = (id: string, path: string, score: number) =>
    vectorHit(id, score, { path, endLine: 1, snippet: `vector ${id}` });
  const keywordResult = (id: string, path: string, score: number) =>
    keywordHit(id, score, { path, endLine: 1, snippet: `keyword ${id}` });

  it("removes the text-weight discount only from vector-only non-text media", async () => {
    const paths = {
      vectorMedia: "memory/generated/photo.png",
      vectorText: "memory/notes.md",
      keywordMedia: "memory/clip.wav",
      bothMedia: "memory/matched.png",
      bothText: "memory/matched.md",
    };
    const merged = await merge({
      isNonTextMediaPath: (path) => /\.(?:png|wav)$/u.test(path),
      vector: [
        vectorResult("vector-media", paths.vectorMedia, 0.8),
        vectorResult("vector-text", paths.vectorText, 0.8),
        vectorResult("both-media", paths.bothMedia, 0.95),
        vectorResult("both-text", paths.bothText, 0.6),
      ],
      keyword: [
        keywordResult("keyword-media", paths.keywordMedia, 0.9),
        keywordResult("both-media", paths.bothMedia, 0.8),
        keywordResult("both-text", paths.bothText, 0.9),
      ],
    });
    const byPath = new Map(merged.map((entry) => [entry.path, entry]));

    expect(byPath.get(paths.vectorMedia)?.score).toBeCloseTo(0.8);
    expect(byPath.get(paths.vectorText)?.score).toBeCloseTo(0.7 * 0.8);
    expect(byPath.get(paths.keywordMedia)?.score).toBeCloseTo(0.3 * 0.9);
    // Relevance 0.8 / (1 - 0.8) = 4 against the strongest 0.9 / (1 - 0.9) = 9.
    expect(byPath.get(paths.bothMedia)?.score).toBeCloseTo(0.7 * 0.95 + 0.3 * (4 / 9) * 0.95);
    expect(byPath.get(paths.bothMedia)?.textScore).toBeCloseTo(0.8);
    expect(byPath.get(paths.bothText)?.score).toBeCloseTo(0.7 * 0.6 + 0.3 * 0.9);
  });
});
