/**
 * Tests for Maximal Marginal Relevance (MMR) re-ranking.
 *
 * Verifies that mmrRerank correctly balances relevance and diversity,
 * using either vector cosine similarity or n-gram Jaccard fallback.
 */
import { describe, it, expect } from "vitest";
import { mmrRerank, type MMRCandidate } from "../core/mmr.js";

describe("mmrRerank", () => {
  it("returns empty array for empty input", () => {
    expect(mmrRerank([], 5)).toEqual([]);
  });

  it("returns all items when count <= limit", () => {
    const candidates: MMRCandidate<string>[] = [
      { item: "a", score: 0.9, content: "hello world" },
      { item: "b", score: 0.7, content: "foo bar" },
    ];
    const result = mmrRerank(candidates, 5);
    expect(result).toEqual(["a", "b"]);
  });

  it("penalizes near-duplicate content (text-based similarity)", () => {
    // Two candidates with nearly identical content, one unique
    const candidates: MMRCandidate<string>[] = [
      { item: "original", score: 0.9, content: "deploy the application to production server" },
      {
        item: "duplicate",
        score: 0.88,
        content: "deploy the application to production server now",
      },
      { item: "diverse", score: 0.85, content: "fix the database connection timeout issue" },
    ];

    const result = mmrRerank(candidates, 2, { lambda: 0.5 });
    // Should prefer "original" (highest) + "diverse" (different content) over "duplicate"
    expect(result).toContain("original");
    expect(result).toContain("diverse");
    expect(result).not.toContain("duplicate");
  });

  it("with lambda=1.0, ranking is purely by score (no diversity penalty)", () => {
    const candidates: MMRCandidate<string>[] = [
      { item: "a", score: 0.9, content: "deploy deploy deploy" },
      { item: "b", score: 0.8, content: "deploy deploy deploy" }, // identical content
      { item: "c", score: 0.7, content: "something completely different" },
    ];

    const result = mmrRerank(candidates, 2, { lambda: 1.0 });
    // Pure relevance: a, b (by score order)
    expect(result[0]).toBe("a");
    expect(result[1]).toBe("b");
  });

  it("with lambda=0.0, ranking is purely by diversity", () => {
    const candidates: MMRCandidate<string>[] = [
      { item: "a", score: 0.9, content: "the quick brown fox jumps" },
      { item: "b", score: 0.88, content: "the quick brown fox leaps" }, // very similar to a
      { item: "c", score: 0.3, content: "database schema migration tool" }, // very different
    ];

    const result = mmrRerank(candidates, 2, { lambda: 0.0 });
    // First pick uses score ties broken by first in list, then diversity dominates
    // After picking first item, second should maximize diversity
    expect(result).toHaveLength(2);
    // The second pick should be 'c' (most different from whatever was picked first)
    expect(result[1]).toBe("c");
  });

  it("uses vector similarity when vectors are provided", () => {
    // Vectors: a and b are nearly identical, c is orthogonal
    const candidates: MMRCandidate<string>[] = [
      { item: "a", score: 0.9, vector: [1, 0, 0] },
      { item: "b", score: 0.88, vector: [0.99, 0.01, 0] }, // almost same direction as a
      { item: "c", score: 0.85, vector: [0, 1, 0] }, // orthogonal to a
    ];

    const result = mmrRerank(candidates, 2, { lambda: 0.5 });
    expect(result).toContain("a");
    expect(result).toContain("c"); // diverse, not b
  });

  it("handles mixed vector/content candidates gracefully", () => {
    // Some have vectors, some don't — falls back to content when vectors missing
    const candidates: MMRCandidate<string>[] = [
      { item: "a", score: 0.9, vector: [1, 0, 0], content: "hello" },
      { item: "b", score: 0.8, content: "hello world" }, // no vector
      { item: "c", score: 0.7, vector: [0, 1, 0], content: "different topic" },
    ];

    const result = mmrRerank(candidates, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("a"); // highest score
  });

  it("handles candidates with no content or vectors (similarity=0)", () => {
    const candidates: MMRCandidate<string>[] = [
      { item: "a", score: 0.9 },
      { item: "b", score: 0.8 },
      { item: "c", score: 0.7 },
    ];

    // No similarity info → all similarity = 0 → pure ranking by score
    const result = mmrRerank(candidates, 2);
    expect(result).toEqual(["a", "b"]);
  });

  it("respects limit parameter", () => {
    const candidates: MMRCandidate<string>[] = Array.from({ length: 20 }, (_, i) => ({
      item: `item-${i}`,
      score: 1 - i * 0.01,
      content: `unique content number ${i} about topic ${i % 5}`,
    }));

    const result = mmrRerank(candidates, 5);
    expect(result).toHaveLength(5);
  });

  it("preserves item references (works with complex objects)", () => {
    type Segment = { id: string; text: string };
    const seg1: Segment = { id: "s1", text: "hello" };
    const seg2: Segment = { id: "s2", text: "world" };

    const candidates: MMRCandidate<Segment>[] = [
      { item: seg1, score: 0.9, content: "hello there" },
      { item: seg2, score: 0.8, content: "world peace" },
    ];

    const result = mmrRerank(candidates, 2);
    expect(result[0]).toBe(seg1); // exact reference
    expect(result[1]).toBe(seg2);
  });

  it("score normalization handles equal scores", () => {
    const candidates: MMRCandidate<string>[] = [
      { item: "a", score: 0.5, content: "alpha" },
      { item: "b", score: 0.5, content: "beta" },
      { item: "c", score: 0.5, content: "gamma" },
    ];

    // All scores equal → final scores all normalized to 0 → diversity decides
    const result = mmrRerank(candidates, 2);
    expect(result).toHaveLength(2);
  });
});
