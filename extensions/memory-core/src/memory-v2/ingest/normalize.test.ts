import { describe, expect, it } from "vitest";
import { contentHash, jaccard, normalizeForMatch, tokenize } from "./normalize.js";

describe("normalizeForMatch", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeForMatch("Hello, World!")).toBe("hello world");
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeForMatch("  a   b\tc\n d  ")).toBe("a b c d");
  });

  it("preserves unicode word chars", () => {
    expect(normalizeForMatch("Café — déjà vu")).toBe("café déjà vu");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeForMatch("   \t\n  ")).toBe("");
  });
});

describe("tokenize", () => {
  it("returns a deduplicated set of tokens", () => {
    const t = tokenize("the the quick brown fox");
    expect(t.size).toBe(4);
    expect(t.has("the")).toBe(true);
  });

  it("returns an empty set on empty input", () => {
    expect(tokenize("").size).toBe(0);
  });
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("returns 0 for disjoint non-empty sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("computes intersection over union", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(2 / 4);
  });

  it("returns 1 when both sets are empty", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when only one side is empty", () => {
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
  });
});

describe("contentHash", () => {
  it("is deterministic and 64-char hex", () => {
    const h = contentHash("hello world");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash("hello world")).toBe(h);
  });

  it("differs for different inputs", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});
