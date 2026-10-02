// Voice Call tests cover telephony reply chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkTelephonyReply, MAX_TELEPHONY_TTS_SYNTH_CHARS } from "./telephony-tts-chunking.js";

describe("chunkTelephonyReply", () => {
  it("returns a short reply unchanged as one piece", () => {
    expect(chunkTelephonyReply("Short answer.", MAX_TELEPHONY_TTS_SYNTH_CHARS)).toEqual([
      "Short answer.",
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(chunkTelephonyReply("   ", MAX_TELEPHONY_TTS_SYNTH_CHARS)).toEqual([]);
  });

  it("splits on sentence boundaries and keeps every piece within the limit", () => {
    const text = Array.from(
      { length: 12 },
      (_, index) => `This is sentence number ${index} with some filler words.`,
    ).join(" ");

    const pieces = chunkTelephonyReply(text, MAX_TELEPHONY_TTS_SYNTH_CHARS);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_TELEPHONY_TTS_SYNTH_CHARS);
      // Sentence-aware splitting never starts a piece mid-word.
      expect(piece).toBe(piece.trim());
    }
    // No spoken content is lost or reordered.
    expect(pieces.join(" ")).toBe(text);
  });

  it("packs consecutive short sentences together rather than one per piece", () => {
    const text = Array.from({ length: 30 }, () => "Yes.").join(" ");

    const pieces = chunkTelephonyReply(text, MAX_TELEPHONY_TTS_SYNTH_CHARS);

    // 30 tiny sentences fit in far fewer pieces than one-per-sentence.
    expect(pieces.length).toBeLessThan(5);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_TELEPHONY_TTS_SYNTH_CHARS);
    }
  });

  it("hard-cuts a single sentence with no whitespace, such as a long URL", () => {
    const url = `https://example.com/${"a".repeat(900)}`;

    const pieces = chunkTelephonyReply(url, MAX_TELEPHONY_TTS_SYNTH_CHARS);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_TELEPHONY_TTS_SYNTH_CHARS);
    }
    expect(pieces.join("")).toBe(url);
  });

  it("keeps leading punctuation when a long reply starts with it", () => {
    const tail = Array.from(
      { length: 12 },
      (_, index) => `Sentence ${index} adds a few filler words here.`,
    ).join(" ");
    const dotNet = `.NET handles this one. ${tail}`;
    const ellipsis = `... so here is the long answer. ${tail}`;
    const question = `? Did you mean the other account? ${tail}`;

    for (const text of [dotNet, ellipsis, question]) {
      const pieces = chunkTelephonyReply(text, MAX_TELEPHONY_TTS_SYNTH_CHARS);

      expect(pieces.length).toBeGreaterThan(1);
      // Whitespace is the only normalization: the reply is trimmed and each
      // piece is trimmed, so the single space at a piece boundary collapses.
      // Every non-whitespace character survives, in order.
      expect(pieces.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
      // Re-inserting that one space reproduces the reply exactly.
      expect(pieces.join(" ")).toBe(text);
    }

    // The opening punctuation run used to be unmatched and silently dropped,
    // so ".NET" was spoken as "NET" and a leading "..." or "?" vanished.
    expect(chunkTelephonyReply(dotNet, MAX_TELEPHONY_TTS_SYNTH_CHARS).at(0)).toMatch(/^\.NET /);
    expect(chunkTelephonyReply(ellipsis, MAX_TELEPHONY_TTS_SYNTH_CHARS).at(0)).toMatch(
      /^\.\.\. so/,
    );
    expect(chunkTelephonyReply(question, MAX_TELEPHONY_TTS_SYNTH_CHARS).at(0)).toMatch(/^\? Did/);
  });

  it("splits CJK sentence punctuation", () => {
    const text = Array.from({ length: 40 }, (_, index) => `这是第${index}个句子。`).join("");

    const pieces = chunkTelephonyReply(text, MAX_TELEPHONY_TTS_SYNTH_CHARS);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_TELEPHONY_TTS_SYNTH_CHARS);
    }
  });
});
