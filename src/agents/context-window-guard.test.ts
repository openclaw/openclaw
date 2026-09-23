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

  it("blocks below the hard-min floor (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 3999,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.source).toBe("model");
    expect(guard.tokens).toBe(3999);
    expect(guard.hardMinTokens).toBe(4000);
    expect(guard.warnBelowTokens).toBe(8000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

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

  it("does not warn at the warning floor (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "ok",
      modelContextWindow: 8_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("uses models.providers.*.models[].contextWindow when present", () => {
    const cfg = openRouterModelConfig({ contextWindow: 3_000 });

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

  it("prefers models.providers.*.models[].contextTokens over contextWindow", () => {
    // contextTokens is the effective usable window; contextWindow can be larger
    // provider metadata and should not overstate prompt budget.
    const cfg = openRouterModelConfig({ contextWindow: 1_050_000, contextTokens: 12_000 });

    const info = resolveContextWindowInfo({
      cfg,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 64_000,
      modelContextTokens: 48_000,
      defaultTokens: 200_000,
    });

    expect(info).toEqual({
      source: "modelsConfig",
      tokens: 12_000,
    });
  });

  it.each([
    ["caps custom input by its native window", "custom", "tiny", 3_000, 16_000, 3_000],
    ["keeps authored input above lower discovery", "custom", "tiny", 32_000, 16_000, 16_000],
    [
      "keeps a native-window override without an input cap",
      "custom",
      "tiny",
      32_000,
      undefined,
      32_000,
    ],
    [
      "ignores stale native metadata for fixed models",
      "anthropic",
      "claude-sonnet-4-6",
      200_000,
      350_000,
      350_000,
    ],
    [
      "caps input by the fixed provider window",
      "anthropic",
      "claude-sonnet-4-6",
      200_000,
      2_000_000,
      1_000_000,
    ],
    [
      "ignores a non-finite cap before fixed-window clamping",
      "anthropic",
      "claude-sonnet-4-6",
      200_000,
      Infinity,
      200_000,
    ],
    ["ignores a sub-token native window", "custom", "tiny", 0.5, 16_000, 16_000],
    ["keeps whole-token guard normalization", "custom", "tiny", 32_000.9, 16_000.9, 16_000],
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

  it.each([false, true])("uses the exact row's context window (exact first=%s)", (exactFirst) => {
    const models = openRouterModelConfig({
      contextWindow: 128_000,
    }).models.providers.openrouter.models.flatMap((model) => [
      { ...model, id: "custom/model", contextWindow: 2_000 },
      { ...model, id: "model", contextWindow: 128_000 },
    ]);
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://example.invalid",
            models: exactFirst ? models.toReversed() : models,
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      provider: "custom",
      modelId: "model",
      modelContextWindow: 128_000,
      defaultTokens: 200_000,
    });

    expect(info).toEqual({ source: "modelsConfig", tokens: 128_000 });
    expect(evaluateContextWindowGuard({ info }).shouldBlock).toBe(false);
  });

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

  it("matches provider-scoped config ids against bare runtime model ids", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "openrouter/tiny",
                name: "tiny",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_000_000,
                contextTokens: 936_000,
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
      modelContextWindow: 128_000,
      defaultTokens: 200_000,
    });

    expect(info).toEqual({
      source: "modelsConfig",
      tokens: 936_000,
    });
  });

  it("does not read models config context windows across provider id variants", () => {
    // Provider id variants are not aliases in config lookup; crossing them would
    // silently apply the wrong operator override.
    const cfg = {
      models: {
        providers: {
          "z.ai": {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "glm-5",
                name: "glm-5",
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
      provider: "z-ai",
      modelId: "glm-5",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });

    expect(info).toEqual({
      source: "model",
      tokens: 64_000,
    });
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

  it("allows overriding thresholds", () => {
    const info = { tokens: 10_000, source: "model" as const };
    const guard = evaluateContextWindowGuard({
      info,
      warnBelowTokens: 12_000,
      hardMinTokens: 9_000,
    });
    expect(guard.hardMinTokens).toBe(9_000);
    expect(guard.warnBelowTokens).toBe(12_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("derives percentage-based guard thresholds above the safe floors", () => {
    const largeGuard = evaluateContextWindowGuard({
      info: { tokens: 1_000_000, source: "model" },
    });
    expect(largeGuard.hardMinTokens).toBe(100_000);
    expect(largeGuard.warnBelowTokens).toBe(200_000);

    const mediumGuard = evaluateContextWindowGuard({
      info: { tokens: 64_000, source: "model" },
    });
    expect(mediumGuard.hardMinTokens).toBe(6_400);
    expect(mediumGuard.warnBelowTokens).toBe(12_800);
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
