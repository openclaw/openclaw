import assert from "node:assert/strict";
/**
 * Tests for Step 1 — scrape candidate pool.
 *
 * Run with: `npx tsx --test src/steps/01-scrape/index.test.ts`
 */
import { describe, it } from "node:test";
import type { Article } from "../../types.js";
import { capPerSource } from "./index.js";

function makeArticle(source: string, title: string, score: number, daysAgo = 0): Article {
  return {
    title,
    url: `https://example.com/${source}/${title.replace(/\s+/g, "-")}`,
    source,
    summary: `${title} summary`,
    score,
    published: new Date(Date.now() - daysAgo * 86_400_000),
  };
}

describe("capPerSource", () => {
  it("keeps all articles when each source is under the cap", () => {
    const input = [
      makeArticle("HN", "a", 100),
      makeArticle("HN", "b", 50),
      makeArticle("Lobsters", "c", 30),
    ];
    const out = capPerSource(input, 3);
    assert.equal(out.length, 3);
  });

  it("caps each source to maxPerSource", () => {
    const input = [
      makeArticle("HN", "h1", 500),
      makeArticle("HN", "h2", 400),
      makeArticle("HN", "h3", 300),
      makeArticle("HN", "h4", 200),
      makeArticle("HN", "h5", 100),
      makeArticle("Lobsters", "l1", 50),
      makeArticle("Lobsters", "l2", 40),
    ];
    const out = capPerSource(input, 3);
    const hn = out.filter((a) => a.source === "HN");
    const lob = out.filter((a) => a.source === "Lobsters");
    assert.equal(hn.length, 3);
    assert.equal(lob.length, 2);
  });

  it("keeps the highest-scoring articles within each source", () => {
    const input = [
      makeArticle("HN", "low", 1),
      makeArticle("HN", "high", 1000),
      makeArticle("HN", "mid", 50),
      makeArticle("HN", "lowest", 0),
    ];
    const out = capPerSource(input, 2);
    const hn = out.filter((a) => a.source === "HN");
    assert.equal(hn.length, 2);
    const titles = hn.map((a) => a.title).sort();
    assert.deepEqual(titles, ["high", "mid"]);
  });

  it("breaks score ties by recency (newer wins)", () => {
    const input = [
      makeArticle("HN", "old", 0, 7),
      makeArticle("HN", "newer", 0, 1),
      makeArticle("HN", "newest", 0, 0),
    ];
    const out = capPerSource(input, 2);
    const titles = out.map((a) => a.title).sort();
    assert.deepEqual(titles, ["newer", "newest"]);
  });

  it("handles empty input", () => {
    assert.deepEqual(capPerSource([], 3), []);
  });

  it("handles a single source dominated by one outlet", () => {
    const input = Array.from({ length: 20 }, (_, i) => makeArticle("HN", `t${i}`, 100 - i));
    const out = capPerSource(input, 3);
    assert.equal(out.length, 3);
    assert.ok(out.every((a) => a.source === "HN"));
  });

  it("preserves at least one article from every source under the cap", () => {
    const sources = ["HN", "Dev.to", "TechCrunch", "The Verge", "Wired", "Ars Technica"];
    const input = sources.flatMap((s, i) =>
      Array.from({ length: 5 }, (_, j) => makeArticle(s, `${s}-${j}`, 100 - i * 10 - j)),
    );
    const out = capPerSource(input, 3);
    const seen = new Set(out.map((a) => a.source));
    assert.equal(seen.size, sources.length);
    assert.equal(out.length, sources.length * 3);
  });
});
