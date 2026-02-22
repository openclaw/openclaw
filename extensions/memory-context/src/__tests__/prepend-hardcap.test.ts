/**
 * Phase 0 — prepend-hardcap.test.ts
 *
 * Verifies that recalled content is always truncated to stay within hardCapTokens,
 * regardless of how many results the search returns.
 */
import { describe, it, expect } from "vitest";
import {
  computeHardCap,
  estimateTokens,
  enforceHardCap,
  type MemoryContextRuntime,
  type MemoryContextConfig,
} from "../core/runtime.js";

function makeRuntime(
  overrides: Partial<
    MemoryContextConfig & { contextWindowTokens?: number; maxHistoryShare?: number }
  > = {},
): MemoryContextRuntime {
  return {
    config: {
      enabled: true,
      hardCapTokens: overrides.hardCapTokens ?? 4000,
      embeddingModel: "hash",
      storagePath: "/tmp/test",
      redaction: true,
      knowledgeExtraction: false,
      maxSegments: 20000,
      crossSession: false,
      autoRecallMinScore: 0.7,
      evictionDays: 90,
    },
    rawStore: {} as any,
    knowledgeStore: {} as any,
    contextWindowTokens: overrides.contextWindowTokens ?? 128000,
    maxHistoryShare: overrides.maxHistoryShare ?? 0.3,
  };
}

describe("hardcap enforcement", () => {
  it("computeHardCap returns min(configured, 10% of context window)", () => {
    // 128k * 0.10 = 12800 > 4000, so configured wins
    expect(computeHardCap(makeRuntime())).toBe(4000);

    // 16k * 0.10 = 1600 < 4000, so 10% wins
    expect(computeHardCap(makeRuntime({ contextWindowTokens: 16000 }))).toBe(1600);
  });

  it("estimateTokens gives reasonable estimates", () => {
    // English: ~4 chars/token, but we use 3 for mixed CJK safety
    expect(estimateTokens("hello")).toBe(2); // 5/3 = 1.67 → 2
    expect(estimateTokens("这是一段中文文本")).toBe(3); // 8 chars / 3 = 2.67 → 3
    expect(estimateTokens("")).toBe(1); // min 1
  });

  it("enforceHardCap truncates low-score segments first", () => {
    const segments = [
      { content: "a".repeat(300), score: 0.9 }, // ~100 tokens
      { content: "b".repeat(300), score: 0.8 }, // ~100 tokens
      { content: "c".repeat(300), score: 0.7 }, // ~100 tokens
      { content: "d".repeat(300), score: 0.6 }, // ~100 tokens
      { content: "e".repeat(300), score: 0.5 }, // ~100 tokens
    ];

    // hardCap = 250 tokens → should keep top 2-3 segments
    const result = enforceHardCap(segments, 250);

    // Total tokens of result should be <= 250
    const totalTokens = result.reduce((sum, s) => sum + estimateTokens(s.content), 0);
    expect(totalTokens).toBeLessThanOrEqual(250);

    // Should keep highest-score segments
    expect(result[0].score).toBe(0.9);
    expect(result.length).toBeLessThan(segments.length);
  });

  it("enforceHardCap allows at least one segment even if it exceeds cap", () => {
    const segments = [
      { content: "x".repeat(9000), score: 0.9 }, // ~3000 tokens, exceeds cap
    ];

    const result = enforceHardCap(segments, 100);
    // Should still include the one segment (at least 1 guarantee)
    expect(result).toHaveLength(1);
  });

  it("enforceHardCap returns empty for empty input", () => {
    expect(enforceHardCap([], 1000)).toHaveLength(0);
  });

  it("enforceHardCap with generous cap returns all segments", () => {
    const segments = [
      { content: "short", score: 0.9 },
      { content: "also short", score: 0.8 },
    ];

    const result = enforceHardCap(segments, 100000);
    expect(result).toHaveLength(2);
  });
});
