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

  describe("model contextWindow capping (issue #24031)", () => {
    // These tests verify the contract used by run.ts to cap model.contextWindow
    // before passing to the SDK. When ctxInfo.source === "agentContextTokens",
    // the capped value should replace model.contextWindow so that the SDK's
    // shouldCompact() triggers at the user's budget, not the model's native window.

    it("returns agentContextTokens source when budget < model window", () => {
      const cfg = {
        agents: { defaults: { contextTokens: 100_000 } },
      } satisfies OpenClawConfig;
      const info = resolveContextWindowInfo({
        cfg,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        modelContextWindow: 272_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("agentContextTokens");
      expect(info.tokens).toBe(100_000);
    });

    it("does not cap when budget >= model window", () => {
      const cfg = {
        agents: { defaults: { contextTokens: 300_000 } },
      } satisfies OpenClawConfig;
      const info = resolveContextWindowInfo({
        cfg,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        modelContextWindow: 272_000,
        defaultTokens: 200_000,
      });
      expect(info.source).toBe("model");
      expect(info.tokens).toBe(272_000);
    });

    it("capped value is usable as model.contextWindow replacement", () => {
      const cfg = {
        agents: { defaults: { contextTokens: 100_000 } },
      } satisfies OpenClawConfig;
      const modelContextWindow = 272_000;
      const info = resolveContextWindowInfo({
        cfg,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        modelContextWindow,
        defaultTokens: 200_000,
      });
      // Simulate the capping logic from run.ts:
      // if (ctxInfo.source === "agentContextTokens" && ctxInfo.tokens < model.contextWindow)
      //   model = { ...model, contextWindow: ctxInfo.tokens };
      const cappedContextWindow =
        info.source === "agentContextTokens" && info.tokens < modelContextWindow
          ? info.tokens
          : modelContextWindow;
      expect(cappedContextWindow).toBe(100_000);
      // SDK's shouldCompact: contextTokens > contextWindow - reserveTokens
      // With capped window: compaction triggers at 100k - 16k = 84k (correct)
      // Without capping: would trigger at 272k - 16k = 256k (bug)
      const reserveTokens = 16_384;
      expect(cappedContextWindow - reserveTokens).toBeLessThan(modelContextWindow - reserveTokens);
      expect(cappedContextWindow - reserveTokens).toBe(100_000 - reserveTokens);
    });
  });
});
