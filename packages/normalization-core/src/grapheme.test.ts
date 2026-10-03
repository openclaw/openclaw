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
];

describe("containingSegment", () => {
  it.each(["grapheme", "word", "sentence"] as const)(
    "matches %s iteration at every UTF-16 index in either query order",
    (granularity) => {
      for (const text of inputs) {
        const segments = new Intl.Segmenter("en", { granularity }).segment(text);
        const expected = Array.from(segments);
        const indices = Array.from({ length: text.length + 2 }, (_, index) => index - 1);
        for (const order of [indices, indices.toReversed()]) {
          for (const index of order) {
            const actual = containingSegment(segments, text, index);
            expect(actual).toEqual(
              expected.find(
                (segment) =>
                  segment.index <= index && index < segment.index + segment.segment.length,
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

  it.each([
    Number.NEGATIVE_INFINITY,
    -1.5,
    -0.5,
    0.5,
    0.9999999999999999,
    1.5,
    2.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("preserves numeric index coercion for %s", (index) => {
    const text = "😀😀";
    const segments = new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text);
    const offset = Number.isNaN(index) ? 0 : Math.trunc(index);
    expect(containingSegment(segments, text, index)).toEqual(
      Array.from(segments).find(
        (segment) => segment.index <= offset && offset < segment.index + segment.segment.length,
      ),
    );
  });
});

describe("findGraphemeChunkEnd", () => {
  it.each(["😀", "🇯🇵", "👨‍👩‍👧‍👦", "👍🏽"])("uses the full budget before another %s cluster", (cluster) => {
    expect(findGraphemeChunkEnd(cluster.repeat(3), 0, cluster.length * 2)).toBe(cluster.length * 2);
  });
});
