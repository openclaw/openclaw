import assert from "node:assert/strict";
/**
 * Tests for Step 5 — TTS pure logic (sanitizer + sentence splitter).
 *
 * `generateTtsAudio`, `kokoroTts`, `edgeTtsAdapter` are IO-bound wrappers
 * covered by the live `--stage slides` verification. Here we lock the
 * sanitizer and sentence splitter behavior.
 *
 * Run with: `npm test`
 */
import { describe, it } from "node:test";
import { sanitizeForTts, splitSentences } from "./sanitize.js";

describe("sanitizeForTts", () => {
  it("strips URLs", () => {
    const out = sanitizeForTts(
      "The report is available at https://example.com/story for anyone interested.",
    );
    assert.doesNotMatch(out, /https?:\/\//);
    assert.match(out, /report is available/);
  });

  it("strips markdown bold, italic, and code", () => {
    const out = sanitizeForTts("This is **bold** and *italic* and `code` text.");
    assert.equal(out, "This is bold and italic and code text.");
  });

  it("strips parenthetical source citations", () => {
    const out = sanitizeForTts("The number reached 2.8 million (according to Wired) in six weeks.");
    assert.doesNotMatch(out, /according to/);
    assert.match(out, /2\.8 million/);
  });

  it("strips bracketed reference markers like [1]", () => {
    const out = sanitizeForTts("This is a claim [1] and another claim [2] from the study.");
    assert.doesNotMatch(out, /\[\d+\]/);
    assert.match(out, /This is a claim/);
  });

  it("keeps normal parentheticals that are not source citations", () => {
    const out = sanitizeForTts("This happens rarely (and not just once).");
    // The whitelist only drops "(according to ...)" / "(source: ...)" patterns
    assert.match(out, /\(and not just once\)/);
  });

  it("strips emoji", () => {
    const out = sanitizeForTts("Breaking news 🚨 something happened ✨ today");
    assert.doesNotMatch(out, /[🚨✨]/);
    assert.match(out, /Breaking news/);
    assert.match(out, /something happened/);
  });

  it("collapses whitespace runs into single spaces", () => {
    const out = sanitizeForTts("lots\n\nof    whitespace\t\there");
    assert.equal(out, "lots of whitespace here");
  });

  it("returns the original when sanitization would produce empty string", () => {
    // Input is 100% a URL that would get stripped → fall back to original
    const raw = "https://foo.com";
    const out = sanitizeForTts(raw);
    assert.equal(out, raw);
  });
});

describe("splitSentences", () => {
  it("splits on sentence boundaries", () => {
    // Tight maxChars forces each sentence into its own chunk
    const out = splitSentences("First sentence. Second sentence. Third sentence.", 20);
    assert.equal(out.length, 3);
    assert.equal(out[0], "First sentence.");
    assert.equal(out[1], "Second sentence.");
    assert.equal(out[2], "Third sentence.");
  });

  it("does not split inside common abbreviations", () => {
    // "Dr. Smith" should stay as one unit, not split after "Dr."
    const out = splitSentences("Dr. Smith made the discovery. The U.S. agreed.", 200);
    assert.equal(out.length, 1);
    assert.match(out[0], /Dr\. Smith/);
    assert.match(out[0], /U\.S\./);
  });

  it("does not split inside decimal numbers", () => {
    // "3.5 million" should stay glued
    const out = splitSentences("The model is 3.5 billion parameters. That is large.", 200);
    assert.equal(out.length, 1);
    assert.match(out[0], /3\.5 billion/);
  });

  it("respects maxChars with greedy fill", () => {
    // Three sentences, each ~20 chars. maxChars=45 → first chunk should fit
    // ~2 sentences, then the 3rd starts a new chunk.
    const input = "Short one here. Short two here. Short three here.";
    const out = splitSentences(input, 35);
    assert.ok(out.length >= 2);
    // No chunk should significantly exceed maxChars (single long sentences are
    // the exception, but all our sentences here fit)
    for (const chunk of out) {
      assert.ok(chunk.length <= 35, `chunk "${chunk}" exceeds 35 chars`);
    }
  });

  it("emits one chunk for a short single sentence", () => {
    const out = splitSentences("Just one sentence here.", 280);
    assert.deepEqual(out, ["Just one sentence here."]);
  });

  it("emits a long sentence as-is when it exceeds maxChars", () => {
    const long =
      "This is an unusually long single sentence that exceeds the default chunk limit by a wide margin and keeps going on and on with lots of embedded detail and content that really should be one unit for TTS.";
    const out = splitSentences(long, 100);
    assert.equal(out.length, 1);
    assert.equal(out[0], long);
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(splitSentences(""), []);
    assert.deepEqual(splitSentences("   "), []);
  });
});
