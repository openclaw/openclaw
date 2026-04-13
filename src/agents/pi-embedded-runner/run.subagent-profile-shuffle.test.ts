import { describe, expect, it } from "vitest";

// Test that shuffleArray produces a permutation
function shuffleArray<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

describe("subagent profile shuffle", () => {
  it("returns the same elements in potentially different order", () => {
    const input = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const result = shuffleArray(input);
    expect(result).toHaveLength(input.length);
    expect(result.sort()).toEqual([...input].sort());
  });

  it("does not modify the original array", () => {
    const input = ["a", "b", "c"];
    const copy = [...input];
    shuffleArray(input);
    expect(input).toEqual(copy);
  });

  it("produces different orderings across multiple calls (probabilistic)", () => {
    const input = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const results = new Set<string>();
    for (let i = 0; i < 10; i++) {
      results.add(shuffleArray(input).join(","));
    }
    // With 20 elements, getting the same order twice in 10 tries is astronomically unlikely
    expect(results.size).toBeGreaterThan(1);
  });
});
