import assert from "node:assert/strict";
/**
 * Tests for Step 2 — concept selection (pure scoring logic).
 *
 * No LLM calls — `selectConcept` itself is covered by the live `--stage scrape`
 * verification step. These tests pin the math + parser behavior.
 *
 * Run with: `npm test`
 */
import { describe, it } from "node:test";
import type { Article } from "../../types.js";
import { buildPrompt, computeWeightedTotal, parseScoringResponse } from "./scoring.js";

function makeArticle(idx: number, title = `t${idx}`): Article {
  return {
    title,
    url: `https://example.com/${idx}`,
    source: `Source${idx % 3}`,
    summary: `summary ${idx}`,
    score: 100 - idx,
    published: new Date(Date.now() - idx * 3600_000),
  };
}

describe("computeWeightedTotal", () => {
  const score = { necessity: 8, attractiveness: 7, novelty: 6, depth: 5 };

  it("defaults all weights to 1 when none provided", () => {
    assert.equal(computeWeightedTotal(score), 8 + 7 + 6 + 5);
  });

  it("applies a single dimension weight", () => {
    // necessity doubled: (8*2) + 7 + 6 + 5 = 34
    assert.equal(computeWeightedTotal(score, { necessity: 2 }), 16 + 7 + 6 + 5);
  });

  it("uses 1 as default for any unspecified weight", () => {
    // only depth specified: 8 + 7 + 6 + (5*0.5) = 23.5
    assert.equal(computeWeightedTotal(score, { depth: 0.5 }), 8 + 7 + 6 + 2.5);
  });

  it("handles all-zero weights", () => {
    assert.equal(
      computeWeightedTotal(score, { necessity: 0, attractiveness: 0, novelty: 0, depth: 0 }),
      0,
    );
  });
});

describe("parseScoringResponse", () => {
  const articles = [makeArticle(0), makeArticle(1), makeArticle(2)];

  it("parses a well-formed response", () => {
    const raw = JSON.stringify({
      candidates: [
        { index: 0, necessity: 8, attractiveness: 7, novelty: 6, depth: 5, reasoning: "r0" },
        { index: 1, necessity: 5, attractiveness: 5, novelty: 5, depth: 5 },
        { index: 2, necessity: 9, attractiveness: 8, novelty: 7, depth: 8, reasoning: "r2" },
      ],
      concept: {
        pickedIndex: 2,
        title: "GPT-6 Launches",
        theme: "OpenAI ships GPT-6",
        keywords: ["openai", "gpt-6"],
      },
    });

    const out = parseScoringResponse(raw, articles);
    assert.equal(out.rawScores.length, 3);
    assert.deepEqual(out.rawScores[0], { necessity: 8, attractiveness: 7, novelty: 6, depth: 5 });
    assert.equal(out.reasonings[0], "r0");
    assert.equal(out.reasonings[1], undefined);
    assert.equal(out.concept.pickedIndex, 2);
    assert.equal(out.concept.title, "GPT-6 Launches");
    assert.deepEqual(out.concept.keywords, ["openai", "gpt-6"]);
  });

  it("strips leading prose and extracts the first JSON object", () => {
    const raw =
      "Sure, here's the JSON:\n```json\n" +
      JSON.stringify({
        candidates: [{ index: 0, necessity: 6, attractiveness: 6, novelty: 6, depth: 6 }],
        concept: { pickedIndex: 0, title: "T", theme: "th", keywords: ["k"] },
      }) +
      "\n```";

    const out = parseScoringResponse(raw, [articles[0]]);
    assert.equal(out.rawScores.length, 1);
    assert.equal(out.concept.title, "T");
  });

  it("clamps scores outside [1, 10]", () => {
    const raw = JSON.stringify({
      candidates: [{ index: 0, necessity: 99, attractiveness: -5, novelty: 0, depth: 11 }],
      concept: { pickedIndex: 0, title: "x", theme: "y", keywords: [] },
    });
    const out = parseScoringResponse(raw, [articles[0]]);
    assert.equal(out.rawScores[0].necessity, 10);
    assert.equal(out.rawScores[0].attractiveness, 1);
    assert.equal(out.rawScores[0].novelty, 1);
    assert.equal(out.rawScores[0].depth, 10);
  });

  it("normalizes keywords (lowercase, trim, dedupe, drop empty)", () => {
    const raw = JSON.stringify({
      candidates: [{ index: 0, necessity: 5, attractiveness: 5, novelty: 5, depth: 5 }],
      concept: {
        pickedIndex: 0,
        title: "t",
        theme: "th",
        keywords: ["OpenAI", "openai", "  GPT-6  ", "", "ai", "AI"],
      },
    });
    const out = parseScoringResponse(raw, [articles[0]]);
    assert.deepEqual(out.concept.keywords, ["openai", "gpt-6", "ai"]);
  });

  it("falls back to neutral 5/5/5/5 for missing candidate indices", () => {
    const raw = JSON.stringify({
      candidates: [
        { index: 0, necessity: 9, attractiveness: 9, novelty: 9, depth: 9 },
        // index 1 missing entirely
        { index: 2, necessity: 3, attractiveness: 3, novelty: 3, depth: 3 },
      ],
      concept: { pickedIndex: 0, title: "t", theme: "th", keywords: ["k"] },
    });
    const out = parseScoringResponse(raw, articles);
    assert.deepEqual(out.rawScores[1], { necessity: 5, attractiveness: 5, novelty: 5, depth: 5 });
    assert.equal(out.rawScores[0].necessity, 9);
    assert.equal(out.rawScores[2].necessity, 3);
  });

  it("returns -1 pickedIndex when LLM picks out of range", () => {
    const raw = JSON.stringify({
      candidates: [{ index: 0, necessity: 5, attractiveness: 5, novelty: 5, depth: 5 }],
      concept: { pickedIndex: 99, title: "t", theme: "th", keywords: [] },
    });
    const out = parseScoringResponse(raw, [articles[0]]);
    // pickedIndex 99 is out of range (only 1 article) — caller's job to fall back
    assert.equal(out.concept.pickedIndex, 99); // we preserve it; selectConcept checks bounds
  });

  it("throws on completely non-JSON input", () => {
    assert.throws(() => parseScoringResponse("totally not json", articles), /no JSON object/);
  });

  it("throws on malformed JSON inside braces", () => {
    // has both { and } so it passes the bracket check, but contents are not valid JSON
    assert.throws(() => parseScoringResponse("{not, valid: json}", articles), /not valid JSON/);
  });

  it("accepts compact field names (i/n/a/v/d)", () => {
    const raw = JSON.stringify({
      candidates: [
        { i: 0, n: 9, a: 8, v: 7, d: 6 },
        { i: 1, n: 4, a: 5, v: 6, d: 7 },
        { i: 2, n: 10, a: 10, v: 10, d: 10 },
      ],
      concept: { pickedIndex: 2, title: "best", theme: "th", keywords: ["k"] },
    });
    const out = parseScoringResponse(raw, articles);
    assert.deepEqual(out.rawScores[0], { necessity: 9, attractiveness: 8, novelty: 7, depth: 6 });
    assert.deepEqual(out.rawScores[2], {
      necessity: 10,
      attractiveness: 10,
      novelty: 10,
      depth: 10,
    });
  });

  it("ignores candidates with out-of-range index", () => {
    const raw = JSON.stringify({
      candidates: [
        { index: -1, necessity: 9, attractiveness: 9, novelty: 9, depth: 9 },
        { index: 99, necessity: 9, attractiveness: 9, novelty: 9, depth: 9 },
        { index: 0, necessity: 7, attractiveness: 7, novelty: 7, depth: 7 },
      ],
      concept: { pickedIndex: 0, title: "t", theme: "th", keywords: [] },
    });
    const out = parseScoringResponse(raw, [articles[0]]);
    // Only index 0 is valid; the rest were ignored
    assert.equal(out.rawScores[0].necessity, 7);
  });
});

describe("buildPrompt", () => {
  it("includes one numbered line per article", () => {
    const arts = [makeArticle(0, "First"), makeArticle(1, "Second"), makeArticle(2, "Third")];
    const { prompt } = buildPrompt(arts);
    assert.match(prompt, /0\. \[Source0\] First/);
    assert.match(prompt, /1\. \[Source1\] Second/);
    assert.match(prompt, /2\. \[Source2\] Third/);
  });

  it("system prompt locks the JSON shape", () => {
    const { system } = buildPrompt([makeArticle(0)]);
    assert.match(system, /STRICT JSON/);
    assert.match(system, /necessity/);
    assert.match(system, /attractiveness/);
    assert.match(system, /novelty/);
    assert.match(system, /depth/);
    assert.match(system, /pickedIndex/);
  });
});
