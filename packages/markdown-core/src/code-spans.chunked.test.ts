import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex, createInlineCodeState } from "./code-spans.js";

const splitAt = (text: string, cuts: readonly number[]): string[] => {
  const bounds = [0, ...cuts, text.length];
  return bounds.slice(0, -1).map((start, index) => text.slice(start, bounds[index + 1]));
};

/** Every offset of every chunk must classify like the one-shot scan of the whole text. */
function expectChunkInvariant(text: string, cuts: readonly number[]) {
  const oneShot = buildCodeSpanIndex(text);
  let inlineState = createInlineCodeState();
  let fenceState = undefined as Parameters<typeof buildCodeSpanIndex>[2];
  let offset = 0;
  for (const chunk of splitAt(text, cuts)) {
    const index = buildCodeSpanIndex(chunk, inlineState, fenceState);
    for (let local = 0; local < chunk.length; local += 1) {
      expect({ at: offset + local, inside: index.isInside(local) }).toEqual({
        at: offset + local,
        inside: oneShot.isInside(offset + local),
      });
    }
    inlineState = index.inlineState;
    fenceState = index.fenceState;
    offset += chunk.length;
  }
  expect(inlineState.open).toBe(oneShot.inlineState.open);
}

const seeded = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

describe("buildCodeSpanIndex chunk invariance", () => {
  it("reassembles a backtick run split across a chunk boundary", () => {
    // "`` ``" one-shot is a single code span, so the space at offset 2 is inside.
    expectChunkInvariant("`` ``", [1]);
  });

  it("reassembles runs split at every boundary of a short span", () => {
    for (const cuts of [[1], [2], [3], [4], [1, 2], [1, 3], [2, 4], [1, 2, 3], [1, 2, 3, 4]]) {
      expectChunkInvariant("`` ``", cuts);
    }
  });

  it("reassembles a longer run delivered one tick at a time", () => {
    // Leading "x" keeps the first line out of fence territory; the runs themselves are inline.
    for (const cuts of [[2], [2, 3, 4], [2, 3, 4, 5, 6, 7, 8, 9]]) {
      expectChunkInvariant("x````x````", cuts);
    }
  });

  it("keeps a closing run split across the boundary from closing early", () => {
    expectChunkInvariant("``a``", [4]);
    expectChunkInvariant("``a``", [3, 4]);
  });

  it("survives an empty chunk between the halves of a split run", () => {
    const text = "`` ``";
    const oneShot = buildCodeSpanIndex(text);
    let inlineState = createInlineCodeState();
    let offset = 0;
    for (const chunk of ["`", "", "` ``"]) {
      const index = buildCodeSpanIndex(chunk, inlineState);
      inlineState = index.inlineState;
      for (let local = 0; local < chunk.length; local += 1) {
        expect(index.isInside(local)).toBe(oneShot.isInside(offset + local));
      }
      offset += chunk.length;
    }
    expect(inlineState.open).toBe(oneShot.inlineState.open);
  });

  it("matches the one-shot scan for random inline text cut at random boundaries", () => {
    const next = seeded(20_261_102);
    const alphabet = ["`", "x", " "];
    let cases = 0;
    while (cases < 300) {
      const length = 1 + Math.floor(next() * 12);
      let text = "";
      for (let i = 0; i < length; i += 1) {
        text += alphabet[Math.floor(next() * alphabet.length)];
      }
      // Up to three leading spaces then three backticks is a fence opener, which the fence
      // scanner owns; this suite covers inline runs.
      if (/^ {0,3}```/.test(text)) continue;
      const cuts = new Set<number>();
      for (let i = 1; i < text.length; i += 1) {
        if (next() < 0.5) cuts.add(i);
      }
      expectChunkInvariant(
        text,
        [...cuts].sort((a, b) => a - b),
      );
      cases += 1;
    }
  });
});
