/**
 * Tests for Semantic Cache Store
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SemanticCacheStore,
  createSemanticCacheStore,
  cosineSimilarity,
  type SemanticCacheConfig,
} from "./semantic-cache-store.js";

describe("Semantic Cache Store", () => {
  const mockConfig: SemanticCacheConfig = {
    enabled: true,
    similarityThreshold: 0.85,
    maxEntries: 100,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    embeddingProvider: "ollama",
    embeddingModel: "nomic-embed-text",
    minQueryLength: 10,
    maxQueryLength: 2000,
  };

  describe("cosineSimilarity", () => {
    it("should calculate perfect similarity for identical vectors", () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(1, 5);
    });

    it("should calculate zero similarity for orthogonal vectors", () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(0, 5);
    });

    it("should throw error for mismatched dimensions", () => {
      const a = [1, 2, 3];
      const b = [1, 2];
      expect(() => cosineSimilarity(a, b)).toThrow("Vector dimension mismatch");
    });

    it("should handle zero vectors", () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBe(0);
    });
  });

  describe("SemanticCacheStore", () => {
    let store: SemanticCacheStore;

    beforeEach(() => {
      store = createSemanticCacheStore(mockConfig);
    });

    afterEach(() => {
      store.clear();
    });

    it("should create a store with correct initial state", () => {
      const stats = store.getStats();
      expect(stats.size).toBe(0);
      expect(stats.maxEntries).toBe(100);
      expect(stats.similarityThreshold).toBe(0.85);
      expect(stats.embeddingProvider).toBe("ollama");
    });

    it("should clear all entries", () => {
      store.clear();
      const stats = store.getStats();
      expect(stats.size).toBe(0);
    });
  });

  describe("createSemanticCacheStore", () => {
    it("should create a store with the provided config", () => {
      const store = createSemanticCacheStore(mockConfig);
      expect(store).toBeInstanceOf(SemanticCacheStore);
      const stats = store.getStats();
      expect(stats.maxEntries).toBe(100);
    });

    it("should create a store with agent ID", () => {
      const store = createSemanticCacheStore(mockConfig, "test-agent");
      expect(store).toBeInstanceOf(SemanticCacheStore);
    });
  });
});
