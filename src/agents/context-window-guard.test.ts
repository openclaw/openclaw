import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  it("blocks below 16k (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 8000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.source).toBe("model");
    expect(guard.tokens).toBe(8000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("warns below 32k but does not block at 16k+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      modelContextWindow: 24_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.tokens).toBe(24_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not warn at 32k+ (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "ok",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("uses models.providers.*.models[].contextWindow when present", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "tiny",
                name: "tiny",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 12_000,
                maxTokens: 256,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("modelsConfig");
    expect(guard.shouldBlock).toBe(true);
  });

  it("caps with agents.defaults.contextTokens", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 20_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 200_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("agentContextTokens");
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not override when cap exceeds base window", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 128_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    expect(info.source).toBe("model");
    expect(info.tokens).toBe(64_000);
  });

  it("uses default when nothing else is available", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "anthropic",
      modelId: "unknown",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("default");
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("allows overriding thresholds", () => {
    const info = { tokens: 10_000, source: "model" as const };
    const guard = evaluateContextWindowGuard({
      info,
      warnBelowTokens: 12_000,
      hardMinTokens: 9_000,
    });
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("exports thresholds as expected", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(32_000);
  });

  describe("knownOverride for Claude 4.6 models (1M context GA)", () => {
    it("overrides claude-opus-4-6 to 1M even when catalog says 200K", () => {
      const info = resolveContextWindowInfo({
        cfg: undefined,
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("knownOverride");
      expect(info.tokens).toBe(1_000_000);
    });

    it("overrides claude-sonnet-4-6 to 1M even when catalog says 200K", () => {
      const info = resolveContextWindowInfo({
        cfg: undefined,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("knownOverride");
      expect(info.tokens).toBe(1_000_000);
    });

    it("handles Bedrock model ID variants (anthropic.claude-opus-4-6-v1)", () => {
      const info = resolveContextWindowInfo({
        cfg: undefined,
        provider: "amazon-bedrock",
        modelId: "anthropic.claude-opus-4-6-v1",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("knownOverride");
      expect(info.tokens).toBe(1_000_000);
    });

    it("handles dot-notation variants (claude-opus-4.6)", () => {
      const info = resolveContextWindowInfo({
        cfg: undefined,
        provider: "openrouter",
        modelId: "anthropic/claude-opus-4.6",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("knownOverride");
      expect(info.tokens).toBe(1_000_000);
    });

    it("modelsConfig takes priority over knownOverride", () => {
      const cfg = {
        models: {
          providers: {
            anthropic: {
              baseUrl: "http://localhost",
              apiKey: "x",
              models: [{ id: "claude-opus-4-6", contextWindow: 200_000 }],
            },
          },
        },
      } satisfies OpenClawConfig;
      const info = resolveContextWindowInfo({
        cfg,
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("modelsConfig");
      expect(info.tokens).toBe(200_000);
    });

    it("does not override unrelated models", () => {
      const info = resolveContextWindowInfo({
        cfg: undefined,
        provider: "anthropic",
        modelId: "claude-opus-4-5",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("model");
      expect(info.tokens).toBe(200_000);
    });

    // Accepted tradeoff: a hypothetical future model with "opus-4-6" in a longer
    // ID (e.g. "claude-opus-4-60") would also match. This is intentional for a
    // temporary shim that will be removed once pi-ai updates its catalog.
    it("matches longer model IDs containing the pattern (accepted tradeoff)", () => {
      const info = resolveContextWindowInfo({
        cfg: undefined,
        provider: "anthropic",
        modelId: "claude-opus-4-60-hypothetical",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("knownOverride");
      expect(info.tokens).toBe(1_000_000);
    });
  });
});
