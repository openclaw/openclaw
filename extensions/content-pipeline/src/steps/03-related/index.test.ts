import assert from "node:assert/strict";
/**
 * Tests for Step 3 — related sources (pure logic only).
 *
 * `fetchFullText` and `findRelatedSources` (network-bound) are covered by
 * the live `--stage scrape` verification step. Here we lock the keyword
 * matcher, the picker, and the cheerio extractor.
 *
 * Run with: `npm test`
 */
import { describe, it } from "node:test";
import type { Article, SelectedConcept } from "../../types.js";
import { extractArticleBody } from "./fetch.js";
import { pickRelated, scoreByKeywords } from "./filter.js";

function makeArticle(idx: number, title: string, summary = "", source = "Src"): Article {
  return {
    title,
    url: `https://example.com/${idx}`,
    source,
    summary,
    score: 100 - idx,
    published: new Date(Date.now() - idx * 3600_000),
  };
}

function makeConcept(seed: Article, keywords: string[]): SelectedConcept {
  return {
    title: "test concept",
    theme: "test theme",
    keywords,
    seedArticle: seed,
    scored: [],
  };
}

describe("scoreByKeywords", () => {
  it("counts whole-token matches in title + summary", () => {
    const a = makeArticle(0, "OpenAI launches GPT-6", "the new model improves reasoning");
    assert.equal(scoreByKeywords(a, ["openai", "gpt-6", "reasoning"]), 3);
  });

  it("is case-insensitive", () => {
    const a = makeArticle(0, "OpenAI Launches GPT-6", "Reasoning gains");
    assert.equal(scoreByKeywords(a, ["OPENAI", "Reasoning"]), 2);
  });

  it("does not match partial tokens (whole-word boundary)", () => {
    const a = makeArticle(0, "Main story", "domain experts agree");
    // "ai" should NOT match "main" or "domain"
    assert.equal(scoreByKeywords(a, ["ai"]), 0);
  });

  it("matches multi-word keywords inside the haystack (expanding tokens)", () => {
    // "project glasswing" expands to ["project glasswing", "project", "glasswing"]
    // "anthropic" stays as ["anthropic"]
    // Title contains "Project Glasswing" (full phrase + both tokens match = 3)
    // Summary contains "anthropic" (1 match)
    // Total: 4
    const a = makeArticle(0, "Project Glasswing launches", "anthropic teams up");
    assert.equal(scoreByKeywords(a, ["project glasswing", "anthropic"]), 4);
  });

  it("returns 0 for an empty keyword list", () => {
    const a = makeArticle(0, "Anything goes", "here too");
    assert.equal(scoreByKeywords(a, []), 0);
  });

  it("expands multi-word keywords into individual tokens", () => {
    // Keyword is the phrase "data centers in space" — should match articles
    // that mention just "datacenter" or "space" even without the full phrase.
    const a = makeArticle(0, "Maine blocks new datacenter growth", "space infrastructure debate");
    // "data centers in space" expands to ["data centers in space", "data", "centers", "space"]
    // "space" matches the summary, "centers" matches the article's mention of "datacenter"? No — word boundary.
    // "space" should match (1), full phrase no, "data" no, "centers" no → 1 match total
    const score = scoreByKeywords(a, ["data centers in space"]);
    assert.ok(score >= 1, `expected at least 1 match, got ${score}`);
  });

  it("drops stopwords when expanding multi-word keywords", () => {
    // "the future of AI" → ["the future of ai", "future", "ai"] (the, of dropped as stopwords)
    // An article titled "Random unrelated news" should NOT match — "future" and "ai" are absent.
    const a = makeArticle(0, "Random unrelated news", "nothing to see");
    assert.equal(scoreByKeywords(a, ["the future of ai"]), 0);
  });
});

describe("pickRelated", () => {
  it("always returns the seed article first", () => {
    const seed = makeArticle(0, "Iran hackers sabotage US infra");
    const pool = [
      seed,
      makeArticle(1, "OpenAI launches GPT-6"),
      makeArticle(2, "Random tech story"),
    ];
    const concept = makeConcept(seed, ["iran", "hackers"]);
    const out = pickRelated(concept, pool, 3);
    assert.equal(out[0].article.url, seed.url);
  });

  it("picks remaining articles by descending keyword overlap, drops zero-overlap", () => {
    const seed = makeArticle(0, "AI hackers attack");
    const a1 = makeArticle(1, "Hackers attack again", "more hackers stuff");
    const a2 = makeArticle(2, "Random unrelated thing");
    const a3 = makeArticle(3, "Hackers everywhere", "hackers and AI hackers");
    const concept = makeConcept(seed, ["hackers", "ai"]);
    const out = pickRelated(concept, [seed, a1, a2, a3], 4);
    // seed first, then a3 (hackers + ai), then a1 (hackers), a2 dropped (0 overlap)
    assert.equal(out.length, 3);
    assert.equal(out[0].article.url, seed.url);
    assert.equal(out[1].article.url, a3.url);
    assert.equal(out[2].article.url, a1.url);
  });

  it("breaks overlap ties by article.score desc", () => {
    const seed = makeArticle(0, "seed");
    const a1 = { ...makeArticle(1, "ai story"), score: 50 };
    const a2 = { ...makeArticle(2, "ai story two"), score: 100 };
    const concept = makeConcept(seed, ["ai"]);
    const out = pickRelated(concept, [seed, a1, a2], 3);
    // Both have 1 keyword match, a2 wins on article.score
    assert.equal(out[1].article.url, a2.url);
    assert.equal(out[2].article.url, a1.url);
  });

  it("returns only the seed when no pool article has keyword overlap", () => {
    const seed = makeArticle(0, "iran hackers");
    const a1 = { ...makeArticle(1, "completely unrelated"), score: 200 };
    const a2 = { ...makeArticle(2, "also unrelated"), score: 150 };
    const concept = makeConcept(seed, ["iran", "hackers"]);
    const out = pickRelated(concept, [seed, a1, a2], 3);
    // No padding — if no pool article matches, only return the seed
    assert.equal(out.length, 1);
    assert.equal(out[0].article.url, seed.url);
  });

  it("returns at most `limit` items even when pool is small", () => {
    const seed = makeArticle(0, "seed");
    const concept = makeConcept(seed, ["seed"]);
    const out = pickRelated(concept, [seed], 5);
    assert.equal(out.length, 1);
  });

  it("returns empty for limit=0", () => {
    const seed = makeArticle(0, "seed");
    const concept = makeConcept(seed, ["seed"]);
    assert.deepEqual(pickRelated(concept, [seed], 0), []);
  });
});

describe("extractArticleBody", () => {
  it("extracts text from <article> element", () => {
    const html = `
      <html><body>
        <header>nav stuff</header>
        <article>
          <h1>The Headline</h1>
          <p>This is the first real paragraph of the story body, long enough to count, and it contains plenty of words so the extractor does not fall back to the paragraph join path because that one would skip the headline.</p>
          <p>Second paragraph with more substantive material to ensure the article element threshold of 200 characters is comfortably exceeded by the extracted body text.</p>
        </article>
        <footer>copyright</footer>
      </body></html>`;
    const out = extractArticleBody(html, 1000);
    assert.match(out, /The Headline/);
    assert.match(out, /first real paragraph/);
    assert.doesNotMatch(out, /nav stuff/);
    assert.doesNotMatch(out, /copyright/);
  });

  it("falls back to <main> when no <article>", () => {
    const html = `
      <html><body>
        <main>
          <p>Main content paragraph one with enough text to pass the body length threshold easily.</p>
          <p>Second main paragraph with even more text content for safety and length passing.</p>
        </main>
      </body></html>`;
    const out = extractArticleBody(html, 1000);
    assert.match(out, /Main content paragraph one/);
  });

  it("falls back to joined <p> tags when no semantic container", () => {
    const html = `
      <html><body>
        <div><p>First loose paragraph with content here in this story body.</p></div>
        <div><p>Second loose paragraph with even more important text and substance.</p></div>
        <p>tiny</p>
      </body></html>`;
    const out = extractArticleBody(html, 1000);
    assert.match(out, /First loose paragraph/);
    assert.match(out, /Second loose paragraph/);
    // "tiny" is below the 20-char minimum, should be skipped
    assert.doesNotMatch(out, /\btiny\b/);
  });

  it("strips scripts and styles before extraction", () => {
    const html = `
      <html><body>
        <article>
          <script>const evil = "should not appear";</script>
          <style>.foo { color: red; }</style>
          <p>The actual story body paragraph with enough text to satisfy length checks.</p>
          <p>Another paragraph for safety and length minimum to be met properly here.</p>
        </article>
      </body></html>`;
    const out = extractArticleBody(html, 1000);
    assert.match(out, /actual story body/);
    assert.doesNotMatch(out, /should not appear/);
    assert.doesNotMatch(out, /color: red/);
  });

  it("strips repeated UI chrome phrases (CommentLoader / Save Story leaks)", () => {
    const html = `
      <html><body>
        <article>
          <p>CommentLoaderSave StorySave this storyCommentLoaderSave StorySave this story</p>
          <p>Thousands of men are members of Telegram groups that trade in hacking tools and abuse content against women, according to new research from a European nonprofit.</p>
          <p>The findings, from an algorithmic auditing group, also describe broader patterns of online harassment and nonconsensual imagery being traded in these communities.</p>
        </article>
      </body></html>`;
    const out = extractArticleBody(html, 2000);
    // The boilerplate leak should be gone
    assert.doesNotMatch(out, /CommentLoader/i);
    assert.doesNotMatch(out, /Save Story/i);
    // The actual story content should still be there
    assert.match(out, /Thousands of men/);
    assert.match(out, /Telegram/);
  });

  it("strips button elements before extraction", () => {
    const html = `
      <html><body>
        <article>
          <button aria-label="Save Story">Save</button>
          <button aria-label="Share">Share</button>
          <p>The real story body begins here with enough length to comfortably clear the two hundred character threshold that the selector-based extractor enforces, so buttons should not leak into the output text at all.</p>
          <p>A second substantial paragraph to make sure the article element is selected rather than falling through to the paragraph fallback path.</p>
        </article>
      </body></html>`;
    const out = extractArticleBody(html, 2000);
    assert.doesNotMatch(out, /\bSave\b/);
    assert.doesNotMatch(out, /\bShare\b/);
    assert.match(out, /real story body/);
  });

  it("caps output to maxChars", () => {
    // Use varied content so the dedup pass doesn't collapse repetitions.
    // Generate 200 distinct sentences roughly ~50 chars each ≈ 10000 chars total.
    const sentences = Array.from(
      { length: 200 },
      (_, i) =>
        `Sentence number ${i} describes some different aspect of the story with unique words like alpha${i} and beta${i}.`,
    );
    const longText = sentences.join(" ");
    const html = `<article><p>${longText}</p></article>`;
    const out = extractArticleBody(html, 500);
    assert.equal(out.length, 500);
  });
});
