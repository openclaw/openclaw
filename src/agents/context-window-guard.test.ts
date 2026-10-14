// Covers context-window guard thresholds and user-facing warning/block text.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  evaluateContextWindowGuard,
  formatContextWindowBlockMessage,
  formatContextWindowWarningMessage,
  resolveContextWindowInfo,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  function openRouterModelConfig(params: { contextWindow: number; contextTokens?: number }) {
    return {
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
                contextWindow: params.contextWindow,
                contextTokens: params.contextTokens,
                maxTokens: 256,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
  }

  it("warns below the warning floor but does not block at hard-min+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      modelContextWindow: 6_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.tokens).toBe(6_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it.each([
    [
      "ignores a non-finite cap before fixed-window clamping",
      "anthropic",
      "claude-sonnet-4-6",
      200_000,
      Infinity,
      200_000,
    ],
    ["ignores a sub-token native window", "custom", "tiny", 0.5, 16_000, 16_000],
  ] as const)(
    "resolves configured context limits (%s)",
    (_case, provider, modelId, contextWindow, contextTokens, expected) => {
      const configured = openRouterModelConfig({ contextWindow, contextTokens });
      const providerConfig = configured.models.providers.openrouter;
      const cfg = {
        models: {
          providers: {
            [provider]: {
              ...providerConfig,
              models: providerConfig.models.map((model) =>
                Object.assign({}, model, { id: modelId }),
              ),
            },
          },
        },
      } satisfies OpenClawConfig;

      expect(
        resolveContextWindowInfo({
          cfg,
          provider,
          modelId,
          modelContextTokens: 8_000,
          modelContextWindow: 8_000,
          defaultTokens: 200_000,
        }),
      ).toEqual({ source: "modelsConfig", tokens: expected });
    },
  );

  it("matches bare provider model config ids against provider-scoped runtime model ids", () => {
    const cfg = openRouterModelConfig({ contextWindow: 1_000_000, contextTokens: 936_000 });

    const info = resolveContextWindowInfo({
      cfg,
      provider: "openrouter",
      modelId: "openrouter/tiny",
      modelContextWindow: 128_000,
      defaultTokens: 200_000,
    });

    expect(info).toEqual({
      source: "modelsConfig",
      tokens: 936_000,
    });
  });

  it("normalizes invalid default context tokens to the warning floor", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "anthropic",
      modelId: "unknown",
      defaultTokens: Number.NaN,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info).toEqual({ source: "default", tokens: 8_000 });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("blocks invalid guard token counts instead of silently passing", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: Number.NaN, source: "model" },
    });
    expect(guard.tokens).toBe(0);
    expect(guard.hardMinTokens).toBe(4_000);
    expect(guard.warnBelowTokens).toBe(8_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("adds a local-model hint to warning messages for localhost endpoints", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 6_000, source: "model" },
    });

    expect(
      formatContextWindowWarningMessage({
        provider: "lmstudio",
        modelId: "qwen3",
        guard,
        runtimeBaseUrl: "http://127.0.0.1:1234/v1",
      }),
    ).toContain("local/self-hosted runs work best at 8000+ tokens");
  });

  it("does not add local-model hints for generic custom endpoints", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 6_000, source: "model" },
    });

    expect(
      formatContextWindowWarningMessage({
        provider: "custom",
        modelId: "hosted-proxy-model",
        guard,
        runtimeBaseUrl: "https://models.example.com/v1",
      }),
    ).toBe("low context window: custom/hosted-proxy-model ctx=6000 (warn<8000) source=model");
  });

  it("adds a local-model hint to block messages for localhost endpoints", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 8_000, source: "model" },
    });

    expect(
      formatContextWindowBlockMessage({
        guard,
        runtimeBaseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toContain("This looks like a local model endpoint.");
  });

  it("points model config block remediation at contextWindow/contextTokens", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 8_000, source: "modelsConfig" },
    });

    expect(
      formatContextWindowBlockMessage({
        guard,
        runtimeBaseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toContain("Raise contextWindow/contextTokens or choose a larger model.");
  });

  it("keeps block messages concise for public providers", () => {
    const guard = evaluateContextWindowGuard({
      info: { tokens: 3_000, source: "model" },
    });

    expect(
      formatContextWindowBlockMessage({
        guard,
        runtimeBaseUrl: "https://api.openai.com/v1",
      }),
    ).toBe(`Model context window too small (3000 tokens; source=model). Minimum is 4000.`);
  });
});
