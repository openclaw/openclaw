import { describe, expect, it } from "vitest";
import {
  shouldProbeEmbeddingUpgrade,
  EMBEDDING_UPGRADE_PROBE_INTERVAL_MS,
  FALLBACK_DIM_THRESHOLD,
  type MemoryContextCacheEntry,
} from "../src/extension-loader.js";

describe("shouldProbeEmbeddingUpgrade", () => {
  it("returns true for hash embedding with no prior probe", () => {
    const entry: MemoryContextCacheEntry = {
      sessionId: "s1",
      embeddingName: "hash",
      embeddingDim: 128,
    };
    expect(shouldProbeEmbeddingUpgrade(entry)).toBe(true);
  });

  it("returns true for none embedding", () => {
    const entry: MemoryContextCacheEntry = {
      sessionId: "s1",
      embeddingName: "none",
      embeddingDim: 0,
    };
    expect(shouldProbeEmbeddingUpgrade(entry)).toBe(true);
  });

  it("returns false for non-fallback embedding", () => {
    const entry: MemoryContextCacheEntry = {
      sessionId: "s1",
      embeddingName: "gemini",
      embeddingDim: 768,
    };
    expect(shouldProbeEmbeddingUpgrade(entry)).toBe(false);
  });

  it("returns false when probed recently", () => {
    const entry: MemoryContextCacheEntry = {
      sessionId: "s1",
      embeddingName: "hash",
      embeddingDim: 128,
      lastUpgradeProbeAt: Date.now() - 1000, // 1s ago
    };
    expect(shouldProbeEmbeddingUpgrade(entry)).toBe(false);
  });

  it("returns true when probe interval elapsed", () => {
    const entry: MemoryContextCacheEntry = {
      sessionId: "s1",
      embeddingName: "hash",
      embeddingDim: 128,
      lastUpgradeProbeAt: Date.now() - EMBEDDING_UPGRADE_PROBE_INTERVAL_MS - 1000,
    };
    expect(shouldProbeEmbeddingUpgrade(entry)).toBe(true);
  });

  it("returns true for low-dim embedding at threshold boundary", () => {
    const entry: MemoryContextCacheEntry = {
      sessionId: "s1",
      embeddingName: "transformer",
      embeddingDim: FALLBACK_DIM_THRESHOLD,
    };
    expect(shouldProbeEmbeddingUpgrade(entry)).toBe(true);
  });

  it("returns false for dim above threshold", () => {
    const entry: MemoryContextCacheEntry = {
      sessionId: "s1",
      embeddingName: "transformer",
      embeddingDim: FALLBACK_DIM_THRESHOLD + 1,
    };
    expect(shouldProbeEmbeddingUpgrade(entry)).toBe(false);
  });
});
