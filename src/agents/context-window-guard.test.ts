import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "./context-window-guard.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  WELL_KNOWN_CONTEXT_WINDOWS,
  WELL_KNOWN_MAX_TOKENS,
} from "./defaults.js";

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
});

describe("WELL_KNOWN_CONTEXT_WINDOWS fallback", () => {
  it("claude-opus-4-6 has 1M context window in well-known map", () => {
    expect(WELL_KNOWN_CONTEXT_WINDOWS["claude-opus-4-6"]).toBe(1_000_000);
  });

  it("claude-sonnet-4-5-20250929 has 200k context window in well-known map", () => {
    expect(WELL_KNOWN_CONTEXT_WINDOWS["claude-sonnet-4-5-20250929"]).toBe(200_000);
  });

  it("unknown model is not in well-known map (falls back to DEFAULT_CONTEXT_TOKENS)", () => {
    const unknown = WELL_KNOWN_CONTEXT_WINDOWS["unknown-model-xyz"];
    expect(unknown).toBeUndefined();
    // The fallback chain: providerCfg?.models?.[0]?.contextWindow ?? WELL_KNOWN_CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_TOKENS
    // When model is not in the map, ?? chains through to DEFAULT_CONTEXT_TOKENS
    expect(unknown ?? DEFAULT_CONTEXT_TOKENS).toBe(200_000);
  });

  it("well-known context window is used when provider config has no contextWindow", () => {
    // Simulates the fallback chain in resolveModel() line 99
    const providerCfg: { models?: Array<{ contextWindow?: number }> } = {};
    const modelId = "claude-opus-4-6";
    const resolved =
      providerCfg?.models?.[0]?.contextWindow ??
      WELL_KNOWN_CONTEXT_WINDOWS[modelId] ??
      DEFAULT_CONTEXT_TOKENS;
    expect(resolved).toBe(1_000_000);
  });

  it("provider config contextWindow takes priority over well-known map", () => {
    const providerCfg = { models: [{ contextWindow: 500_000 }] };
    const modelId = "claude-opus-4-6";
    const resolved =
      providerCfg?.models?.[0]?.contextWindow ??
      WELL_KNOWN_CONTEXT_WINDOWS[modelId] ??
      DEFAULT_CONTEXT_TOKENS;
    expect(resolved).toBe(500_000);
  });

  it("WELL_KNOWN_MAX_TOKENS has matching entries", () => {
    expect(WELL_KNOWN_MAX_TOKENS["claude-opus-4-6"]).toBe(32_000);
    expect(WELL_KNOWN_MAX_TOKENS["claude-sonnet-4-5-20250929"]).toBe(16_000);
    expect(WELL_KNOWN_MAX_TOKENS["unknown-model-xyz"]).toBeUndefined();
  });
});
