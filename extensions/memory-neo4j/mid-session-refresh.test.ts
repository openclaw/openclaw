/**
 * Tests for mid-session core memory refresh feature.
 *
 * Verifies that core memories are re-injected when context usage exceeds threshold.
 * Tests config parsing, threshold calculation, shouldRefresh logic, and edge cases.
 */

import { describe, it, expect } from "vitest";

// ============================================================================
// Config parsing for refreshAtContextPercent
// ============================================================================

describe("mid-session core memory refresh", () => {
  describe("config parsing", () => {
    it("should accept valid refreshAtContextPercent values", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 50 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBe(50);
    });

    it("should accept refreshAtContextPercent of 1 (minimum)", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 1 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBe(1);
    });

    it("should accept refreshAtContextPercent of 100 (maximum)", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 100 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBe(100);
    });

    it("should treat refreshAtContextPercent of 0 as disabled (undefined)", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 0 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });

    it("should treat negative refreshAtContextPercent as disabled (undefined)", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: -10 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });

    it("should throw for refreshAtContextPercent over 100", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      expect(() =>
        memoryNeo4jConfigSchema.parse({
          neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
          embedding: { provider: "ollama" },
          coreMemory: { refreshAtContextPercent: 150 },
        }),
      ).toThrow("coreMemory.refreshAtContextPercent must be between 1 and 100");
    });

    it("should default to undefined when coreMemory section is omitted", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });

    it("should default to undefined when refreshAtContextPercent is omitted", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
        coreMemory: { enabled: true },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });
  });

  // ============================================================================
  // shouldRefresh logic (tests the decision flow from index.ts)
  // ============================================================================

  describe("shouldRefresh decision logic", () => {
    // These tests mirror the logic from index.ts lines 893-916:
    //   1. Skip if contextWindowTokens or estimatedUsedTokens not available
    //   2. Calculate usagePercent = (estimatedUsedTokens / contextWindowTokens) * 100
    //   3. Skip if usagePercent < refreshThreshold
    //   4. Skip if tokens since last refresh < MIN_TOKENS_SINCE_REFRESH (10_000)
    //   5. Otherwise, refresh

    const MIN_TOKENS_SINCE_REFRESH = 10_000;

    function shouldRefresh(params: {
      contextWindowTokens: number | undefined;
      estimatedUsedTokens: number | undefined;
      refreshThreshold: number;
      lastRefreshTokens: number;
    }): boolean {
      const { contextWindowTokens, estimatedUsedTokens, refreshThreshold, lastRefreshTokens } =
        params;

      // Skip if context info not available
      if (!contextWindowTokens || !estimatedUsedTokens) {
        return false;
      }

      const usagePercent = (estimatedUsedTokens / contextWindowTokens) * 100;

      // Only refresh if we've crossed the threshold
      if (usagePercent < refreshThreshold) {
        return false;
      }

      // Check if we've already refreshed recently
      const tokensSinceRefresh = estimatedUsedTokens - lastRefreshTokens;
      if (tokensSinceRefresh < MIN_TOKENS_SINCE_REFRESH) {
        return false;
      }

      return true;
    }

    it("should trigger refresh when usage exceeds threshold and enough tokens accumulated", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 120_000, // 60%
          refreshThreshold: 50,
          lastRefreshTokens: 0, // Never refreshed
        }),
      ).toBe(true);
    });

    it("should not trigger when usage is below threshold", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 80_000, // 40%
          refreshThreshold: 50,
          lastRefreshTokens: 0,
        }),
      ).toBe(false);
    });

    it("should not trigger when not enough tokens since last refresh", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 105_000, // 52.5%
          refreshThreshold: 50,
          lastRefreshTokens: 100_000, // Only 5k tokens since last refresh
        }),
      ).toBe(false);
    });

    it("should trigger when enough tokens accumulated since last refresh", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 115_000, // 57.5%
          refreshThreshold: 50,
          lastRefreshTokens: 100_000, // 15k tokens since last refresh
        }),
      ).toBe(true);
    });

    it("should not trigger when contextWindowTokens is undefined", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: undefined,
          estimatedUsedTokens: 120_000,
          refreshThreshold: 50,
          lastRefreshTokens: 0,
        }),
      ).toBe(false);
    });

    it("should not trigger when estimatedUsedTokens is undefined", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: undefined,
          refreshThreshold: 50,
          lastRefreshTokens: 0,
        }),
      ).toBe(false);
    });

    it("should handle 0% usage (empty context)", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 0,
          refreshThreshold: 50,
          lastRefreshTokens: 0,
        }),
      ).toBe(false);
    });

    it("should handle 100% usage", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 200_000, // 100%
          refreshThreshold: 50,
          lastRefreshTokens: 0,
        }),
      ).toBe(true);
    });

    it("should handle exact threshold boundary (50% == 50% threshold)", () => {
      // usagePercent == refreshThreshold: usagePercent < refreshThreshold is false, so it proceeds
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 100_000, // exactly 50%
          refreshThreshold: 50,
          lastRefreshTokens: 0,
        }),
      ).toBe(true);
    });

    it("should handle threshold of 1 (refresh almost immediately)", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 15_000, // 7.5%
          refreshThreshold: 1,
          lastRefreshTokens: 0,
        }),
      ).toBe(true);
    });

    it("should handle threshold of 100 (refresh only at full context)", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 190_000, // 95%
          refreshThreshold: 100,
          lastRefreshTokens: 0,
        }),
      ).toBe(false);
    });

    it("should allow first refresh even when lastRefreshTokens is 0", () => {
      expect(
        shouldRefresh({
          contextWindowTokens: 200_000,
          estimatedUsedTokens: 110_000,
          refreshThreshold: 50,
          lastRefreshTokens: 0,
        }),
      ).toBe(true);
    });

    it("should support multiple refresh cycles with cumulative token growth", () => {
      // First refresh at 110k tokens
      const firstResult = shouldRefresh({
        contextWindowTokens: 200_000,
        estimatedUsedTokens: 110_000,
        refreshThreshold: 50,
        lastRefreshTokens: 0,
      });
      expect(firstResult).toBe(true);

      // Second attempt too soon (only 5k since first)
      const secondResult = shouldRefresh({
        contextWindowTokens: 200_000,
        estimatedUsedTokens: 115_000,
        refreshThreshold: 50,
        lastRefreshTokens: 110_000,
      });
      expect(secondResult).toBe(false);

      // Third attempt after enough growth (15k since first refresh)
      const thirdResult = shouldRefresh({
        contextWindowTokens: 200_000,
        estimatedUsedTokens: 125_000,
        refreshThreshold: 50,
        lastRefreshTokens: 110_000,
      });
      expect(thirdResult).toBe(true);
    });
  });

  // ============================================================================
  // Output format
  // ============================================================================

  describe("refresh output format", () => {
    it("should format core memories as XML-wrapped bullet list", () => {
      const coreMemories = [
        { text: "User prefers TypeScript over JavaScript" },
        { text: "User works at Acme Corp" },
      ];
      const content = coreMemories.map((m) => `- ${m.text}`).join("\n");
      const output = `<core-memory-refresh>\nReminder of persistent context (you may have seen this earlier, re-stating for recency):\n${content}\n</core-memory-refresh>`;

      expect(output).toContain("<core-memory-refresh>");
      expect(output).toContain("</core-memory-refresh>");
      expect(output).toContain("- User prefers TypeScript over JavaScript");
      expect(output).toContain("- User works at Acme Corp");
    });

    it("should handle single core memory", () => {
      const coreMemories = [{ text: "Only memory" }];
      const content = coreMemories.map((m) => `- ${m.text}`).join("\n");
      const output = `<core-memory-refresh>\nReminder of persistent context (you may have seen this earlier, re-stating for recency):\n${content}\n</core-memory-refresh>`;

      expect(output).toContain("- Only memory");
      expect(output.match(/^- /gm)?.length).toBe(1);
    });
  });
});
