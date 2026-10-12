import { describe, expect, it } from "vitest";
import { containingSegment, findGraphemeChunkEnd } from "./grapheme.js";

const inputs = [
  "",
  "abc",
  "😀".repeat(50),
  "a😀b",
  "a🇯🇵🇦🇹b",
  "a👨‍👩‍👧‍👦b",
  "a👍🏽👍🏻b",
  "Hi. 👍 Bye.",
  "\ud83d",
  "\ude00",
  "\ud83dabc\ud83d",
  "\ude00abc\ude00",
  "\ud83d😀\ude00",
  "a\ud83db\ude00c",
  "\ud83d\ud83d\ude00\ude00",
].map((text) => ({
  text,
  indices: Array.from({ length: text.length + 2 }, (_, index) => index - 1),
}));
inputs.push({
  text: "😀😀",
  indices: [-Infinity, -1.5, -0.5, 0.5, 0.9999999999999999, 1.5, 2.5, Number.NaN, Infinity],
});

describe("containingSegment", () => {
  it.each(["grapheme", "word", "sentence"] as const)(
    "matches %s iteration at integer and coerced indices in either query order",
    (granularity) => {
      for (const { text, indices } of inputs) {
        const segments = new Intl.Segmenter("en", { granularity }).segment(text);
        const expected = Array.from(segments);
        for (const order of [indices, indices.toReversed()]) {
          for (const index of order) {
            const offset = Number.isNaN(index) ? 0 : Math.trunc(index);
            const actual = containingSegment(segments, text, index);
            expect(actual).toEqual(
              expected.find(
                (segment) =>
                  segment.index <= offset && offset < segment.index + segment.segment.length,
              ),
            );
            if (!process.versions.bun) {
              expect(actual).toEqual(segments.containing(index));
            }
          }
        }
      }
    },
  );
});

describe("findGraphemeChunkEnd", () => {
  it.each(["😀", "🇯🇵", "👨‍👩‍👧‍👦", "👍🏽"])("uses the full budget before another %s cluster", (cluster) => {
    expect(findGraphemeChunkEnd(cluster.repeat(3), 0, cluster.length * 2)).toBe(cluster.length * 2);
  });
});
