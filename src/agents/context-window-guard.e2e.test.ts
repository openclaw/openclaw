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

  describe("context1m param", () => {
    function makeCfg(modelKey: string, overrides: Record<string, unknown> = {}): OpenClawConfig {
      return {
        agents: {
          defaults: {
            models: {
              [modelKey]: { params: { context1m: true } },
            },
            ...overrides,
          },
        },
      } as unknown as OpenClawConfig;
    }

    it("returns 1M tokens for claude-opus-4-6 with context1m: true", () => {
      const info = resolveContextWindowInfo({
        cfg: makeCfg("anthropic/claude-opus-4-6"),
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.tokens).toBe(1_000_000);
    });

    it("returns 1M tokens for claude-sonnet-4-6 with context1m: true", () => {
      const info = resolveContextWindowInfo({
        cfg: makeCfg("anthropic/claude-sonnet-4-6"),
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.tokens).toBe(1_000_000);
    });

    it("returns 1M tokens for future claude-opus-4-7 with context1m: true", () => {
      const info = resolveContextWindowInfo({
        cfg: makeCfg("anthropic/claude-opus-4-7"),
        provider: "anthropic",
        modelId: "claude-opus-4-7",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.tokens).toBe(1_000_000);
    });

    it("ignores context1m on non-1M-capable models (haiku)", () => {
      const info = resolveContextWindowInfo({
        cfg: makeCfg("anthropic/claude-haiku-3-5"),
        provider: "anthropic",
        modelId: "claude-haiku-3-5",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.tokens).toBe(200_000);
    });

    it("respects explicit models.providers contextWindow override over context1m", () => {
      const cfg = {
        models: {
          providers: {
            anthropic: {
              models: [{ id: "claude-opus-4-6", contextWindow: 150_000 }],
            },
          },
        },
        agents: {
          defaults: {
            models: { "anthropic/claude-opus-4-6": { params: { context1m: true } } },
          },
        },
      } as unknown as OpenClawConfig;
      const info = resolveContextWindowInfo({
        cfg,
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.tokens).toBe(150_000);
      expect(info.source).toBe("modelsConfig");
    });

    it("applies agents.defaults.contextTokens cap even with context1m: true", () => {
      const cfg = makeCfg("anthropic/claude-opus-4-6", { contextTokens: 500_000 });
      const info = resolveContextWindowInfo({
        cfg,
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        modelContextWindow: 200_000,
        defaultTokens: 200_000,
      });
      expect(info.tokens).toBe(500_000);
      expect(info.source).toBe("agentContextTokens");
    });
  });
});
