// Markdown Core tests cover plain-text chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk-text.js";

describe("chunkText", () => {
  it("normalizes positive fractional limits without emitting empty chunks", () => {
    expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
    expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
  });

  it.each([
    ["family emoji", "👨‍👩‍👧‍👦"],
    ["flag", "🇺🇸"],
    ["emoji modifier", "👋🏽"],
    ["combining sequence", "e\u0301"],
    ["Indic conjunct", "क्ष"],
  ])("keeps a %s whole at a hard boundary", (_name, grapheme) => {
    const limit = Math.max(4, grapheme.length);
    const firstCodePointLength = Array.from(grapheme)[0]?.length ?? 1;
    const prefix = "a".repeat(limit - firstCodePointLength);
    const text = `${prefix}${grapheme}Z`;
    const chunks = chunkText(text, limit);

    expect(chunks[0]).toBe(prefix);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= limit)).toBe(true);
  });
});
