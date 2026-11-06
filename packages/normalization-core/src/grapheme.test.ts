import { describe, expect, it } from "vitest";
import { findGraphemeChunkEnd } from "./grapheme.js";

describe("findGraphemeChunkEnd", () => {
  it.each(["😀", "🇯🇵", "👨‍👩‍👧‍👦", "👍🏽"])("uses the full budget before another %s cluster", (cluster) => {
    expect(findGraphemeChunkEnd(cluster.repeat(3), 0, cluster.length * 2)).toBe(cluster.length * 2);
  });
});
