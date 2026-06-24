// Twitch tests cover markdown stripping and chunk boundary safety.
import { describe, expect, it } from "vitest";
import { chunkTextForTwitch, stripMarkdownForTwitch } from "./markdown.js";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** True when any chunk starts or ends with a dangling (unpaired) surrogate half. */
function hasDanglingSurrogate(chunks: string[]): boolean {
  return chunks.some((chunk) => {
    if (chunk.length === 0) {
      return false;
    }
    const first = chunk.charCodeAt(0);
    const last = chunk.charCodeAt(chunk.length - 1);
    return isLowSurrogate(first) || isHighSurrogate(last);
  });
}

describe("stripMarkdownForTwitch", () => {
  it("strips basic formatting and collapses newlines to spaces", () => {
    expect(stripMarkdownForTwitch("**bold** and _italic_\nsecond line")).toBe(
      "bold and italic second line",
    );
  });
});

describe("chunkTextForTwitch", () => {
  it("returns a single chunk when text fits within the limit", () => {
    expect(chunkTextForTwitch("hello world", 500)).toEqual(["hello world"]);
  });

  it("splits on word boundaries when spaces are available", () => {
    const chunks = chunkTextForTwitch("alpha beta gamma", 7);
    expect(chunks).toEqual(["alpha", "beta", "gamma"]);
  });

  it("reassembles back to the original code points after a hard split", () => {
    // No spaces, so the chunker is forced into the hard-split branch.
    const input = `x${"\u{1F389}".repeat(300)}`; // one ASCII char + 300 emoji
    const chunks = chunkTextForTwitch(input, 500);
    expect(chunks.join("")).toBe(input);
  });

  it("never splits a surrogate pair across two chunks on a hard split", () => {
    // 601 UTF-16 units, no spaces: the naive slice(0, 500) lands in the middle
    // of an emoji surrogate pair, producing dangling halves. The fix must keep
    // every emoji whole inside a single chunk.
    const input = `x${"\u{1F389}".repeat(300)}`;
    const chunks = chunkTextForTwitch(input, 500);
    expect(hasDanglingSurrogate(chunks)).toBe(false);
    // First chunk backs off one unit to keep the pair intact (index 499, odd).
    expect(chunks[0].length).toBe(499);
  });

  it("keeps a minimal emoji case whole across chunks", () => {
    const input = `a${"\u{1F600}".repeat(4)}`; // "a😀😀😀😀", limit 2
    const chunks = chunkTextForTwitch(input, 2);
    expect(hasDanglingSurrogate(chunks)).toBe(false);
    expect(chunks.join("")).toBe(input);
  });
});
