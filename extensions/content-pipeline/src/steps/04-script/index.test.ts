import assert from "node:assert/strict";
/**
 * Tests for Step 4 — single-concept deep-dive script (pure logic only).
 *
 * `generateConceptScript` (LLM-bound) is covered by the live --stage content
 * verification. Here we lock the prompt builder + parser behavior.
 *
 * Run with: `npm test`
 */
import { describe, it } from "node:test";
import type {
  Article,
  FullArticle,
  PipelineConfig,
  SelectedConcept,
  SlideContent,
} from "../../types.js";
import { buildConceptPrompt, parseConceptScript } from "./prompts.js";

function makeArticle(idx: number, title = `t${idx}`): Article {
  return {
    title,
    url: `https://example.com/${idx}`,
    source: `Src${idx}`,
    summary: `summary ${idx}`,
    score: 100 - idx,
    published: new Date(Date.now() - idx * 3600_000),
  };
}

function makeSource(idx: number, opts: Partial<FullArticle> = {}): FullArticle {
  return {
    ...makeArticle(idx),
    fullText: `full body text ${idx}`,
    fetchOk: true,
    keywordMatches: 1,
    ...opts,
  };
}

function makeConcept(): SelectedConcept {
  const seed = makeArticle(0, "Iran cyberattack");
  return {
    title: "Iran Cyberattacks US Infrastructure",
    theme: "Iran linked hackers sabotage US energy and water infrastructure",
    keywords: ["iran", "hackers", "infrastructure", "cyberattack"],
    seedArticle: seed,
    scored: [],
  };
}

const contentConfig: PipelineConfig["content"] = {
  model: "test/model",
  topStories: 5,
  language: "en",
  tone: "energetic",
};

/** Build a valid 7-slide script JSON for parser tests. */
function validScriptJson(overrides: Partial<{ tags: unknown; videoDescription: unknown }> = {}) {
  const slides: SlideContent[] = [
    { slideType: "intro", title: "Hook", body: "- a\n- b", speakerNotes: "Intro narration." },
    { slideType: "story", title: "What Happened", body: "- a\n- b", speakerNotes: "Notes." },
    { slideType: "story", title: "The Background", body: "- a\n- b", speakerNotes: "Notes." },
    { slideType: "story", title: "Key Details", body: "- a\n- b", speakerNotes: "Notes." },
    { slideType: "story", title: "Analysis", body: "- a\n- b", speakerNotes: "Notes." },
    { slideType: "story", title: "Why It Matters", body: "- a\n- b", speakerNotes: "Notes." },
    { slideType: "outro", title: "Wrap", body: "- a\n- b", speakerNotes: "Outro." },
  ];
  return JSON.stringify({
    videoTitle: "Iran Hacks US",
    videoDescription: "A deep dive.",
    tags: ["iran", "hackers"],
    slides,
    ...overrides,
  });
}

describe("buildConceptPrompt", () => {
  it("includes concept title, theme, and keywords in the user prompt", () => {
    const concept = makeConcept();
    const { prompt } = buildConceptPrompt(concept, [makeSource(1)], contentConfig);
    assert.match(prompt, /CONCEPT: Iran Cyberattacks US Infrastructure/);
    assert.match(prompt, /THEME: Iran linked hackers sabotage/);
    assert.match(prompt, /KEYWORDS: iran, hackers, infrastructure, cyberattack/);
  });

  it("includes each usable source with a labeled header + full body", () => {
    const concept = makeConcept();
    const sources = [
      makeSource(1, { title: "First", fullText: "first body content here" }),
      makeSource(2, { title: "Second", fullText: "second body content here" }),
    ];
    const { prompt } = buildConceptPrompt(concept, sources, contentConfig);
    assert.match(prompt, /=== Source 1: First/);
    assert.match(prompt, /first body content here/);
    assert.match(prompt, /=== Source 2: Second/);
    assert.match(prompt, /second body content here/);
  });

  it("drops sources with fetchOk: false", () => {
    const concept = makeConcept();
    const sources = [
      makeSource(1, { title: "ok source" }),
      makeSource(2, { title: "failed source", fetchOk: false, fullText: "" }),
    ];
    const { prompt } = buildConceptPrompt(concept, sources, contentConfig);
    assert.match(prompt, /ok source/);
    assert.doesNotMatch(prompt, /failed source/);
  });

  it("falls back to the seed article summary when no sources are usable", () => {
    const concept = makeConcept();
    // All sources failed
    const sources = [makeSource(1, { fetchOk: false, fullText: "" })];
    const { prompt } = buildConceptPrompt(concept, sources, contentConfig);
    assert.match(prompt, /=== Seed Article: Iran cyberattack/);
    assert.match(prompt, /summary 0/);
  });

  it("system prompt locks the 7-slide arc and JSON shape", () => {
    const { system } = buildConceptPrompt(makeConcept(), [makeSource(1)], contentConfig);
    assert.match(system, /EXACTLY 7 slides/);
    assert.match(system, /What Happened/);
    assert.match(system, /The Background/);
    assert.match(system, /Key Details/);
    assert.match(system, /Analysis/);
    assert.match(system, /Why It Matters/);
    assert.match(system, /STRICT JSON/);
  });
});

describe("parseConceptScript", () => {
  it("parses a well-formed 7-slide response", () => {
    const out = parseConceptScript(validScriptJson());
    assert.equal(out.slides.length, 7);
    assert.equal(out.videoTitle, "Iran Hacks US");
    assert.deepEqual(
      out.slides.map((s) => s.slideType),
      ["intro", "story", "story", "story", "story", "story", "outro"],
    );
  });

  it("strips leading prose and code fences", () => {
    const raw = "Here's the JSON:\n```json\n" + validScriptJson() + "\n```";
    const out = parseConceptScript(raw);
    assert.equal(out.slides.length, 7);
  });

  it("normalizes body from string (bulleted lines) into the SlideContent body field", () => {
    const out = parseConceptScript(validScriptJson());
    // Body was "- a\n- b" → normalizeBody strips bullets, joins with \n
    assert.equal(out.slides[0].body, "a\nb");
  });

  it("normalizes body from array input", () => {
    const json = JSON.stringify({
      videoTitle: "T",
      slides: [
        { slideType: "intro", title: "i", body: ["point one", "point two"], speakerNotes: "n" },
        { slideType: "story", title: "s1", body: ["a"], speakerNotes: "n" },
        { slideType: "story", title: "s2", body: ["a"], speakerNotes: "n" },
        { slideType: "story", title: "s3", body: ["a"], speakerNotes: "n" },
        { slideType: "story", title: "s4", body: ["a"], speakerNotes: "n" },
        { slideType: "story", title: "s5", body: ["a"], speakerNotes: "n" },
        { slideType: "outro", title: "o", body: ["a"], speakerNotes: "n" },
      ],
    });
    const out = parseConceptScript(json);
    assert.equal(out.slides[0].body, "point one\npoint two");
  });

  it("throws when slides.length !== 7", () => {
    const json = JSON.stringify({
      videoTitle: "T",
      slides: [
        { slideType: "intro", title: "i", body: [], speakerNotes: "" },
        { slideType: "outro", title: "o", body: [], speakerNotes: "" },
      ],
    });
    assert.throws(() => parseConceptScript(json), /exactly 7 slides/);
  });

  it("throws when slideType sequence is wrong", () => {
    const json = JSON.stringify({
      videoTitle: "T",
      slides: [
        { slideType: "story", title: "w1", body: [], speakerNotes: "" }, // should be intro
        { slideType: "story", title: "w2", body: [], speakerNotes: "" },
        { slideType: "story", title: "w3", body: [], speakerNotes: "" },
        { slideType: "story", title: "w4", body: [], speakerNotes: "" },
        { slideType: "story", title: "w5", body: [], speakerNotes: "" },
        { slideType: "story", title: "w6", body: [], speakerNotes: "" },
        { slideType: "story", title: "w7", body: [], speakerNotes: "" }, // should be outro
      ],
    });
    assert.throws(() => parseConceptScript(json), /sequence is wrong/);
  });

  it("fills defaults for missing videoDescription and tags", () => {
    const json = JSON.stringify({
      videoTitle: "T",
      slides: [
        { slideType: "intro", title: "i", body: [], speakerNotes: "Intro narration here." },
        { slideType: "story", title: "s1", body: [], speakerNotes: "" },
        { slideType: "story", title: "s2", body: [], speakerNotes: "" },
        { slideType: "story", title: "s3", body: [], speakerNotes: "" },
        { slideType: "story", title: "s4", body: [], speakerNotes: "" },
        { slideType: "story", title: "s5", body: [], speakerNotes: "" },
        { slideType: "outro", title: "o", body: [], speakerNotes: "" },
      ],
    });
    const out = parseConceptScript(json);
    assert.equal(out.videoDescription, "Intro narration here.");
    assert.deepEqual(out.tags, ["tech news"]);
  });

  it("throws on completely non-JSON input", () => {
    assert.throws(() => parseConceptScript("not json at all"), /no JSON object/);
  });

  it("throws on malformed JSON inside braces", () => {
    assert.throws(() => parseConceptScript("{bad, json}"), /not valid JSON/);
  });
});
