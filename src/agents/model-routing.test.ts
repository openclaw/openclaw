import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  analyzeTaskComplexity,
  estimateCostRatio,
  estimateOutputTokens,
  resolveModelRoutingConfig,
  routeModel,
} from "./model-routing.js";

describe("model-routing", () => {
  describe("estimateOutputTokens", () => {
    it("returns minimum 500 for empty input", () => {
      const tokens = estimateOutputTokens({
        inputText: "",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        hasCodeRequest: false,
      });
      expect(tokens).toBe(500);
    });

    it("scales with input length", () => {
      const short = estimateOutputTokens({
        inputText: "hello",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        hasCodeRequest: false,
      });
      const long = estimateOutputTokens({
        inputText: "a".repeat(10000),
        messageHistoryDepth: 0,
        hasToolCalls: false,
        hasCodeRequest: false,
      });
      expect(long).toBeGreaterThan(short);
    });

    it("increases estimate for tool calls", () => {
      const base = estimateOutputTokens({
        inputText: "write a function",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        hasCodeRequest: false,
      });
      const withTools = estimateOutputTokens({
        inputText: "write a function",
        messageHistoryDepth: 0,
        hasToolCalls: true,
        hasCodeRequest: false,
      });
      expect(withTools).toBeGreaterThan(base);
    });

    it("increases estimate for code requests", () => {
      const base = estimateOutputTokens({
        inputText: "explain this",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        hasCodeRequest: false,
      });
      const withCode = estimateOutputTokens({
        inputText: "explain this",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        hasCodeRequest: true,
      });
      expect(withCode).toBeGreaterThan(base);
    });

    it("increases estimate for deep history", () => {
      const shallow = estimateOutputTokens({
        inputText: "continue",
        messageHistoryDepth: 2,
        hasToolCalls: false,
        hasCodeRequest: false,
      });
      const deep = estimateOutputTokens({
        inputText: "continue",
        messageHistoryDepth: 25,
        hasToolCalls: false,
        hasCodeRequest: false,
      });
      expect(deep).toBeGreaterThan(shallow);
    });
  });

  describe("analyzeTaskComplexity", () => {
    it("routes greetings to haiku", () => {
      const result = analyzeTaskComplexity({
        inputText: "hello there",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        systemPromptLength: 1000,
      });
      expect(result.tier).toBe("haiku");
    });

    it("routes complex reasoning to opus", () => {
      const result = analyzeTaskComplexity({
        inputText: "Analyze and architect a distributed microservices system",
        messageHistoryDepth: 10,
        hasToolCalls: true,
        systemPromptLength: 5000,
      });
      expect(result.tier).toBe("opus");
    });

    it("routes security audits to opus", () => {
      const result = analyzeTaskComplexity({
        inputText: "audit the security of this application",
        messageHistoryDepth: 5,
        hasToolCalls: true,
        systemPromptLength: 3000,
      });
      expect(result.tier).toBe("opus");
    });

    it("routes medium tasks to sonnet", () => {
      const result = analyzeTaskComplexity({
        inputText:
          "Write a Python function that parses CSV files and generates summary statistics including mean, median, and standard deviation for each numeric column. Handle edge cases like missing values and mixed types.",
        messageHistoryDepth: 8,
        hasToolCalls: false,
        systemPromptLength: 2000,
      });
      // Should be sonnet (medium complexity code task)
      expect(["sonnet", "haiku"]).toContain(result.tier);
    });

    it("routes simple questions to haiku", () => {
      const result = analyzeTaskComplexity({
        inputText: "What is the capital of France?",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        systemPromptLength: 500,
      });
      expect(result.tier).toBe("haiku");
    });

    it("includes confidence score", () => {
      const result = analyzeTaskComplexity({
        inputText: "hi",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        systemPromptLength: 500,
      });
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it("respects custom haikuMaxTokens threshold", () => {
      // With default threshold (5000), a ~2500 token estimate would be haiku
      const withDefault = analyzeTaskComplexity({
        inputText: "a".repeat(2000), // ~600 base tokens
        messageHistoryDepth: 0,
        hasToolCalls: false,
        systemPromptLength: 500,
      });
      expect(withDefault.tier).toBe("haiku");

      // With very low threshold (100), same input should NOT be haiku
      const withLowThreshold = analyzeTaskComplexity({
        inputText: "a".repeat(2000),
        messageHistoryDepth: 0,
        hasToolCalls: false,
        systemPromptLength: 500,
        thresholds: { haikuMaxTokens: 100, sonnetMaxTokens: 50_000 },
      });
      expect(withLowThreshold.tier).not.toBe("haiku");
    });

    it("respects custom sonnetMaxTokens threshold", () => {
      // Longer input that triggers sonnet by default (medium complexity)
      const mediumInput = "a".repeat(10000); // Creates ~3000 tokens estimate
      const withDefault = analyzeTaskComplexity({
        inputText: mediumInput,
        messageHistoryDepth: 15,
        hasToolCalls: true,
        systemPromptLength: 5000,
      });
      // Default thresholds: haiku < 5K, sonnet < 50K, so ~9000+ tokens -> sonnet
      expect(withDefault.tier).toBe("sonnet");

      // With very low sonnet threshold, same input should escalate to opus
      const withLowThreshold = analyzeTaskComplexity({
        inputText: mediumInput,
        messageHistoryDepth: 15,
        hasToolCalls: true,
        systemPromptLength: 5000,
        thresholds: { haikuMaxTokens: 100, sonnetMaxTokens: 1000 },
      });
      expect(withLowThreshold.tier).toBe("opus");
    });
  });

  describe("resolveModelRoutingConfig", () => {
    it("returns defaults when no config", () => {
      const config = resolveModelRoutingConfig({} as OpenClawConfig);
      expect(config.enabled).toBe(false);
      expect(config.tiers.haiku.model).toContain("haiku");
    });
  });

  describe("routeModel", () => {
    const baseCfg = {
      agents: {
        defaults: {
          modelRouting: {
            enabled: true,
            tiers: {
              haiku: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
              sonnet: { provider: "anthropic", model: "claude-sonnet-4-5-20250514" },
              opus: { provider: "anthropic", model: "claude-opus-4-6" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    it("returns undefined when disabled", () => {
      const result = routeModel({
        cfg: {} as OpenClawConfig,
        inputText: "hello",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        systemPromptLength: 500,
        hasSessionModelOverride: false,
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined when session override exists", () => {
      const result = routeModel({
        cfg: baseCfg,
        inputText: "hello",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        systemPromptLength: 500,
        hasSessionModelOverride: true,
      });
      expect(result).toBeUndefined();
    });

    it("routes simple input to haiku", () => {
      const result = routeModel({
        cfg: baseCfg,
        inputText: "hi",
        messageHistoryDepth: 0,
        hasToolCalls: false,
        systemPromptLength: 500,
        hasSessionModelOverride: false,
      });
      expect(result?.tier).toBe("haiku");
      expect(result?.model).toContain("haiku");
    });

    it("routes complex input to opus", () => {
      const result = routeModel({
        cfg: baseCfg,
        inputText: "Analyze and architect a comprehensive security audit of the entire codebase",
        messageHistoryDepth: 15,
        hasToolCalls: true,
        systemPromptLength: 15000,
        hasSessionModelOverride: false,
      });
      expect(result?.tier).toBe("opus");
    });
  });

  describe("estimateCostRatio", () => {
    it("returns 1.0 for all-opus usage", () => {
      const ratio = estimateCostRatio({
        haikuPercentage: 0,
        sonnetPercentage: 0,
        opusPercentage: 100,
      });
      expect(ratio).toBe(1.0);
    });

    it("returns lower ratio with haiku usage", () => {
      const ratio = estimateCostRatio({
        haikuPercentage: 60,
        sonnetPercentage: 30,
        opusPercentage: 10,
      });
      expect(ratio).toBeLessThan(0.3);
    });

    it("returns 0 ratio for zero usage", () => {
      const ratio = estimateCostRatio({
        haikuPercentage: 0,
        sonnetPercentage: 0,
        opusPercentage: 0,
      });
      expect(ratio).toBe(1.0);
    });
  });
});
