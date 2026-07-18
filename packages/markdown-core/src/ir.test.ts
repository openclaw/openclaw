import { describe, expect, it } from "vitest";
import { sliceMarkdownIR, markdownToIR } from "./ir.js";

// U+1F600 (😀) = 😀 in UTF-16.
const EMOJI = "\u{1F600}";
const LEAD_HIGH = "\uD83D"; // High surrogate for U+1F600
const LEAD_LOW = "\uDE00"; // Low surrogate for U+1F600

describe("sliceMarkdownIR surrogate pair boundaries", () => {
  it("expands start boundary backward when it lands on a low surrogate", () => {
    // "a😀b" — UTF-16: [a] [\uD83D] [\uDE00] [b], indices 0-3
    const ir = markdownToIR(`a${EMOJI}b`);
    // from=2 points at \uDE00 (LS); should expand to from=1 to include 😀
    const sliced = sliceMarkdownIR(ir, 2, 4);
    expect(sliced.text).toBe(`${EMOJI}b`);
  });

  it("expands end boundary forward when it splits between HS and LS", () => {
    // "a😀b" — UTF-16: [a] [\uD83D] [\uDE00] [b], indices 0-3
    const ir = markdownToIR(`a${EMOJI}b`);
    // to=2 splits between \uD83D (HS) and \uDE00 (LS); should expand to to=3
    const sliced = sliceMarkdownIR(ir, 0, 2);
    expect(sliced.text).toBe(`a${EMOJI}`);
  });

  it("preserves full text when boundaries are already clean", () => {
    const ir = markdownToIR(`a${EMOJI}b`);
    // Clean boundaries that don't split any surrogate pair
    const sliced = sliceMarkdownIR(ir, 0, 4);
    expect(sliced.text).toBe(`a${EMOJI}b`);
  });

  it("leaves boundaries unchanged when start is on a high surrogate", () => {
    const ir = markdownToIR(`a${EMOJI}b`);
    // from=1 points at \uD83D (HS) — start of pair, no adjustment needed
    const sliced = sliceMarkdownIR(ir, 1, 4);
    expect(sliced.text).toBe(`${EMOJI}b`);
  });

  it("handles multiple consecutive surrogate pairs", () => {
    // U+1F600 😀 (😀) + U+1F431 🐱 (🐱)
    // Indices: 0=HS😀, 1=LS😀, 2=HS🐱, 3=LS🐱, len=4
    const cat = "\u{1F431}";
    const ir = markdownToIR(`${EMOJI}${cat}`);
    // from=1 is LS of 😀 → expand backward to 0; to=4 is past end → stays 4
    const sliced = sliceMarkdownIR(ir, 1, 4);
    expect(sliced.text).toBe(`${EMOJI}${cat}`);
  });

  it("preserves empty slice when start === end lands inside a surrogate pair", () => {
    // "a😀b" — UTF-16: [a] [\uD83D] [\uDE00] [b], indices 0-3
    // start=end=2 lands on \uDE00 (LS); must remain empty, not expand to "😀"
    const ir = markdownToIR(`a${EMOJI}b`);
    const sliced = sliceMarkdownIR(ir, 2, 2);
    expect(sliced.text).toBe("");
  });

  it("preserves empty slice when start === end lands on a high surrogate", () => {
    // start=end=1 lands on \uD83D (HS); must remain empty
    const ir = markdownToIR(`a${EMOJI}b`);
    const sliced = sliceMarkdownIR(ir, 1, 1);
    expect(sliced.text).toBe("");
  });

  it("handles negative start index", () => {
    const ir = markdownToIR(`a${EMOJI}b`);
    // from=-2 => len-2 = 2, which is LS; should expand backward to 1
    const sliced = sliceMarkdownIR(ir, -2, 4);
    expect(sliced.text).toBe(`${EMOJI}b`);
  });

  it("propagates adjusted boundaries to link spans", () => {
    const ir = markdownToIR(`a[${EMOJI}b](https://example.com)`);
    // from=2 is LS, should expand to 1
    const sliced = sliceMarkdownIR(ir, 2, ir.text.length);
    expect(sliced.text).toContain(EMOJI);
    expect(sliced.links.length).toBeGreaterThan(0);
  });

  it("preserves normalized empty slice with mixed positive/negative indices", () => {
    // After normalization: start=-1 → from=len-1 which is > to=0 = normalized empty.
    // Surrogate adjustment must not expand this into a non-empty slice.
    const ir = markdownToIR(`a${EMOJI}b`);
    const sliced = sliceMarkdownIR(ir, -1, 0);
    expect(sliced.text).toBe("");
  });
});
