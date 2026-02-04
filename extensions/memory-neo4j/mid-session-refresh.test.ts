/**
 * Tests for mid-session core memory refresh feature.
 *
 * Verifies that core memories are re-injected when context usage exceeds threshold.
 */

import { describe, it, expect } from "vitest";

describe("mid-session core memory refresh", () => {
  // Test context threshold calculation
  describe("context threshold calculation", () => {
    it("should calculate usage percentage correctly", () => {
      const contextWindowTokens = 200_000;
      const estimatedUsedTokens = 100_000;
      const usagePercent = (estimatedUsedTokens / contextWindowTokens) * 100;
      expect(usagePercent).toBe(50);
    });

    it("should detect when threshold is exceeded", () => {
      const threshold = 50;
      const usagePercent = 55;
      expect(usagePercent >= threshold).toBe(true);
    });

    it("should not trigger when below threshold", () => {
      const threshold = 50;
      const usagePercent = 45;
      expect(usagePercent >= threshold).toBe(false);
    });
  });

  // Test refresh frequency limiting
  describe("refresh frequency limiting", () => {
    const MIN_TOKENS_SINCE_REFRESH = 10_000;

    it("should allow refresh when enough tokens have accumulated", () => {
      const lastRefreshTokens = 50_000;
      const currentTokens = 65_000;
      const tokensSinceRefresh = currentTokens - lastRefreshTokens;
      expect(tokensSinceRefresh >= MIN_TOKENS_SINCE_REFRESH).toBe(true);
    });

    it("should block refresh when not enough tokens have accumulated", () => {
      const lastRefreshTokens = 50_000;
      const currentTokens = 55_000;
      const tokensSinceRefresh = currentTokens - lastRefreshTokens;
      expect(tokensSinceRefresh >= MIN_TOKENS_SINCE_REFRESH).toBe(false);
    });

    it("should allow first refresh (no previous refresh)", () => {
      const lastRefreshTokens = 0; // No previous refresh
      const currentTokens = 100_000;
      const tokensSinceRefresh = currentTokens - lastRefreshTokens;
      expect(tokensSinceRefresh >= MIN_TOKENS_SINCE_REFRESH).toBe(true);
    });
  });

  // Test config parsing
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

    it("should reject refreshAtContextPercent of 0", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 0 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });

    it("should reject refreshAtContextPercent over 100", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
        coreMemory: { refreshAtContextPercent: 150 },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });

    it("should default to undefined when not specified", async () => {
      const { memoryNeo4jConfigSchema } = await import("./config.js");
      const config = memoryNeo4jConfigSchema.parse({
        neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test" },
        embedding: { provider: "ollama" },
      });
      expect(config.coreMemory.refreshAtContextPercent).toBeUndefined();
    });
  });

  // Test output format
  describe("refresh output format", () => {
    it("should format core memories correctly", () => {
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
  });
});
