// Memory Core tests cover hybrid plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildFtsQuery,
  mergeHybridResults,
  scoreExactPathTieForTemporalDecay,
  selectHybridSearchResults,
} from "./hybrid.js";
import { bm25RankToScore } from "./keyword-query.js";

type HybridInputs = Parameters<typeof mergeHybridResults>[0];
type VectorHit = HybridInputs["vector"][number];
type KeywordHit = HybridInputs["keyword"][number];

function vectorHit(id: string, vectorScore: number, details: Partial<VectorHit> = {}): VectorHit {
  return {
    id,
    path: `memory/${id}.md`,
    startLine: 1,
    endLine: 2,
    source: "memory",
    snippet: id,
    vectorScore,
    ...details,
  };
}

function keywordHit(id: string, textScore: number, details: Partial<KeywordHit> = {}): KeywordHit {
  return {
    id,
    path: `memory/${id}.md`,
    startLine: 1,
    endLine: 2,
    source: "memory",
    snippet: id,
    textScore,
    ...details,
  };
}

describe("memory hybrid helpers", () => {
  it("buildFtsQuery tokenizes and AND-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
    expect(buildFtsQuery("金银价格")).toBe('"金银价格"');
    expect(buildFtsQuery("価格 2026年")).toBe('"価格" AND "2026年"');
    expect(buildFtsQuery("   ")).toBeNull();
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
    expect(strongest).not.toBe(middle);
    expect(middle).not.toBe(weakest);
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
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      mmr: { enabled: true, lambda: 0.2 },
      vector: [
        vectorHit("strict-first", 1, { endLine: 1, snippet: "shared semantic topic" }),
        vectorHit("strict-later", 0.9, { endLine: 1, snippet: "shared semantic topic" }),
      ],
      keyword: [keyword],
    });
    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/strict-first.md",
      "memory/keyword-first.md",
      "memory/strict-later.md",
    ]);

    const selected = selectHybridSearchResults({
      merged,
      keyword: [keyword],
      maxResults: 2,
      minScore: 0.35,
    });

    expect(selected.map((entry) => entry.path)).toEqual([
      "memory/strict-first.md",
      "memory/strict-later.md",
    ]);
  });

  it("keeps the relaxed keyword-backed fallback when no result is strict", () => {
    const overlapping = {
      path: "memory/overlap.md",
      startLine: 2,
      endLine: 3,
      source: "memory",
      snippet: "overlapping vector and keyword match",
      score: 0.2,
      vectorScore: 0.1,
      textScore: 0.5,
    };

    const selected = selectHybridSearchResults({
      merged: [overlapping],
      keyword: [overlapping],
      maxResults: 1,
      minScore: 0.35,
    });

    expect(selected).toEqual([overlapping]);
  });

  it("keeps null importance neutral and deterministically boosts important entries", async () => {
    const baseEntry = vectorHit("neutral", 0.8, { path: "MEMORY.md", endLine: 1 });
    const base = {
      vectorWeight: 1,
      textWeight: 0,
      keyword: [],
      vector: [baseEntry],
    };
    const neutral = await mergeHybridResults(base);
    const important = await mergeHybridResults({
      ...base,
      vector: [{ ...baseEntry, id: "important", importance: 10 }],
    });
    const low = await mergeHybridResults({
      ...base,
      vector: [{ ...baseEntry, id: "low", importance: 1 }],
    });

    expect(neutral[0]?.score).toBeCloseTo(0.8);
    expect(important[0]?.score).toBeCloseTo(1);
    expect(low[0]?.score).toBeCloseTo(0.64);
  });

  it("boosts active-project results, demotes foreign results, and leaves global results neutral", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      keyword: [],
      vector: [
        vectorHit("same", 0.8, {
          path: "MEMORY.md",
          endLine: 1,
          projectKey: "github.com/openclaw/openclaw",
        }),
        vectorHit("global", 0.8, { path: "MEMORY.md", startLine: 2 }),
        vectorHit("foreign", 0.8, {
          path: "MEMORY.md",
          startLine: 3,
          endLine: 3,
          projectKey: "github.com/example/other",
        }),
      ],
    });
    expect(merged.map((entry) => [entry.snippet, entry.score])).toEqual([
      ["same", 0.9199999999999999],
      ["global", 0.8],
      ["foreign", 0.7200000000000001],
    ]);
  });

  it.each([
    {
      label: "without project affinity",
      activeProjectKeys: undefined,
      expected: ["memory/primary.md", "memory/diverse.md"],
    },
    {
      label: "with project affinity",
      activeProjectKeys: ["active-project"],
      expected: ["memory/duplicate.md", "memory/diverse.md"],
    },
  ])("keeps a diverse hit in the selected set $label", async ({ activeProjectKeys, expected }) => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      mmr: { enabled: true, lambda: 0.7 },
      activeProjectKeys,
      keyword: [],
      vector: [
        vectorHit("primary", 0.9, { endLine: 1, snippet: "alpha beta gamma" }),
        vectorHit("duplicate", 0.8, {
          endLine: 1,
          snippet: "alpha beta gamma delta",
          projectKey: "active-project",
        }),
        vectorHit("diverse", 0.75, { endLine: 1, snippet: "whiskey tango" }),
        vectorHit("floor", 0.2, { endLine: 1, snippet: "alpha" }),
      ],
    });

    expect(merged.slice(0, 2).map((entry) => entry.path)).toEqual(expected);
  });

  it("uses path BM25 only for partial path-only hybrid hits", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [],
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
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
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

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/2026-07-10.md",
      "memory/2020-01-01.md",
    ]);
    expect(merged.map((entry) => entry.score)).toEqual([1, 1]);
    expect(merged.every((entry) => entry.textScore === 0)).toBe(true);
  });

  it("ignores zero-weight and non-positive content when ordering exact hybrid hits", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      vector: [vectorHit("vector", -1, { path: "memory/z/foo.md", exactPathSpecificity: 2 })],
      keyword: [
        keywordHit("body", 1, { path: "memory/y/foo.md", exactPathSpecificity: 2 }),
        keywordHit("path", 0, { path: "memory/a/foo.md", pathScore: 1, exactPathSpecificity: 2 }),
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/a/foo.md",
      "memory/y/foo.md",
      "memory/z/foo.md",
    ]);
  });

  it("uses net weighted content relevance for exact hybrid ordering", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 1,
      vector: [
        vectorHit("cancelled", -1, {
          path: "memory/z/foo.md",
          snippet: "negative vector",
          exactPathSpecificity: 2,
        }),
      ],
      keyword: [
        keywordHit("cancelled", 0.5, {
          path: "memory/z/foo.md",
          snippet: "weak body",
          exactPathSpecificity: 2,
        }),
        keywordHit("path", 0, {
          path: "memory/a/foo.md",
          snippet: "path only",
          pathScore: 1,
          exactPathSpecificity: 2,
        }),
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual(["memory/a/foo.md", "memory/z/foo.md"]);
  });

  it("keeps the full content-backed exact group ahead of path-only hits through MMR", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0,
      textWeight: 1,
      mmr: { enabled: true, lambda: 0.5 },
      vector: [],
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

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/z/foo.md",
      "memory/y/foo.md",
      "memory/a/foo.md",
    ]);
  });

  it("keeps vector-only exact path candidates ahead of stronger semantic matches", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 1,
      vector: [
        vectorHit("semantic", 0.99),
        vectorHit("exact-vector", 0.2, {
          path: "memory/deep/README.md",
          snippet: "exact vector",
          exactPathSpecificity: 2,
        }),
      ],
      keyword: [],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/deep/README.md",
      "memory/semantic.md",
    ]);
    expect(merged[0]?.score).toBe(1);
    expect(merged[0]?.vectorScore).toBe(0.2);
  });

  it("uses specificity across exact tiers and combined relevance within one tier", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        vectorHit("full", 0),
        vectorHit("basename-weak", 0.2, { path: "memory/a/foo.md", snippet: "basename weak" }),
        vectorHit("basename-strong", 0.9, { path: "memory/z/foo.md", snippet: "basename strong" }),
        vectorHit("stem", 1, { path: "memory/foo.md.bak" }),
      ],
      keyword: [
        keywordHit("full", 0, { exactPathSpecificity: 3 }),
        keywordHit("basename-weak", 0.1, {
          path: "memory/a/foo.md",
          snippet: "basename weak",
          pathScore: 1,
          exactPathSpecificity: 2,
        }),
        keywordHit("basename-path-only", 0, {
          path: "memory/0/foo.md",
          snippet: "basename path only",
          pathScore: 1,
          exactPathSpecificity: 2,
        }),
        keywordHit("basename-strong", 0.8, {
          path: "memory/z/foo.md",
          snippet: "basename strong",
          pathScore: 0.01,
          exactPathSpecificity: 2,
        }),
        keywordHit("stem", 1, { path: "memory/foo.md.bak", exactPathSpecificity: 1 }),
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/full.md",
      "memory/z/foo.md",
      "memory/a/foo.md",
      "memory/0/foo.md",
      "memory/foo.md.bak",
    ]);
    expect(merged.map((entry) => entry.score)).toEqual([1, 1, 1, 1, 1]);
  });

  it("keeps exact path identifiers ahead after decay, oversized weights, and MMR", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 1,
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

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/2020-01-01.md",
      "memory/semantic.md",
    ]);
    expect(merged[0]?.score).toBe(1);
    expect(merged[1]?.score).toBe(2);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [vectorHit("a", 0.2, { snippet: "vec-a" })],
      keyword: [keywordHit("a", 1, { snippet: "kw-a" })],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1);
    expect(merged[0]?.vectorScore).toBeCloseTo(0.2);
    expect(merged[0]?.textScore).toBeCloseTo(1);
  });

  it.each([null, 0.5, -0.5])(
    "preserves LIKE lexical ties and public confidence with vector score %s",
    async (vectorScore) => {
      const keyword = [
        { id: "aaa", rankingScore: 0.2 },
        { id: "zzz", rankingScore: 0.8 },
      ].map(({ id, rankingScore }) => ({
        id,
        path: `memory/${id}.md`,
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: `${id} substring overlap`,
        textScore: 0,
        hasBodyMatch: true,
        rankingScore,
        pathScore: 0,
        exactPathSpecificity: 0 as const,
      }));
      const merged = await mergeHybridResults({
        vectorWeight: 0.7,
        textWeight: 0.3,
        vector: vectorScore === null ? [] : keyword.map((entry) => ({ ...entry, vectorScore })),
        keyword,
      });

      // LIKE strength breaks tied confidence without turning recall into a scored match.
      expect(merged.map((entry) => entry.path)).toEqual(["memory/zzz.md", "memory/aaa.md"]);
      expect(merged).toEqual([
        expect.objectContaining({
          score: (vectorScore ?? 0) * 0.7,
          vectorScore: vectorScore ?? 0,
          textScore: 0,
        }),
        expect.objectContaining({
          score: (vectorScore ?? 0) * 0.7,
          vectorScore: vectorScore ?? 0,
          textScore: 0,
        }),
      ]);
      expect(merged.every((entry) => !("lexicalRank" in entry) && !("rankingScore" in entry))).toBe(
        true,
      );
      const selected = selectHybridSearchResults({ merged, keyword, maxResults: 2, minScore: 0 });
      expect(selected).toEqual(vectorScore !== null && vectorScore < 0 ? [] : merged);
    },
  );

  const vectorResult = (id: string, path: string, vectorScore: number) => ({
    id,
    path,
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: `vector ${id}`,
    vectorScore,
  });
  const keywordResult = (id: string, path: string, textScore: number) => ({
    id,
    path,
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: `keyword ${id}`,
    textScore,
  });

  it("removes the text-weight discount only from vector-only non-text media", async () => {
    const paths = {
      vectorMedia: "memory/generated/photo.png",
      vectorText: "memory/notes.md",
      keywordMedia: "memory/clip.wav",
      bothMedia: "memory/matched.png",
      bothText: "memory/matched.md",
    };
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
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
    expect(byPath.get(paths.bothMedia)?.score).toBeCloseTo(0.7 * 0.95 + 0.3 * 0.8);
    expect(byPath.get(paths.bothMedia)?.textScore).toBeCloseTo(0.8);
    expect(byPath.get(paths.bothText)?.score).toBeCloseTo(0.7 * 0.6 + 0.3 * 0.9);
  });

  it("keeps media keyword scoring when vector weight is zero", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0,
      textWeight: 1,
      isNonTextMediaPath: (candidatePath) => candidatePath.endsWith(".png"),
      vector: [vectorResult("candidate", "memory/photo.png", 0.95)],
      keyword: [keywordResult("candidate", "memory/photo.png", 0.8)],
    });

    expect(merged.find((entry) => entry.path === "memory/photo.png")?.score).toBeCloseTo(0.8);
  });

  it("keeps vector-only text scoring when weights total two", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 1,
      isNonTextMediaPath: (candidatePath) => candidatePath.endsWith(".png"),
      vector: [vectorResult("candidate", "memory/notes.md", 0.6)],
      keyword: [],
    });

    expect(merged.find((entry) => entry.path === "memory/notes.md")?.score).toBeCloseTo(0.6);
  });
});
