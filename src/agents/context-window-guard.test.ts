import { describe, expect, it } from "vitest";
import { modelConfig } from "./context-config.test-support.js";
import {
  evaluateContextWindowGuard,
  formatContextWindowBlockMessage,
  formatContextWindowWarningMessage,
  resolveContextWindowInfo,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  const guardFor = (tokens: number, source: "model" | "modelsConfig" = "model") =>
    evaluateContextWindowGuard({ info: { tokens, source } });
  const blockMessage = (
    tokens: number,
    runtimeBaseUrl: string,
    source: "model" | "modelsConfig" = "model",
  ) => formatContextWindowBlockMessage({ guard: guardFor(tokens, source), runtimeBaseUrl });

  it("warns below the warning floor but does not block at hard-min+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      modelContextWindow: 6_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard).toMatchObject({ tokens: 6_000, shouldWarn: true, shouldBlock: false });
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
      expect(
        resolveContextWindowInfo({
          cfg: modelConfig(provider, modelId, { contextWindow, contextTokens }),
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
    const info = resolveContextWindowInfo({
      cfg: modelConfig("openrouter", "tiny", { contextWindow: 1_000_000, contextTokens: 936_000 }),
      provider: "openrouter",
      modelId: "openrouter/tiny",
      modelContextWindow: 128_000,
      defaultTokens: 200_000,
    });

    expect(info).toEqual({ source: "modelsConfig", tokens: 936_000 });
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
    expect(guard).toMatchObject({ shouldWarn: false, shouldBlock: false });
  });

  it("blocks invalid guard token counts instead of silently passing", () => {
    expect(guardFor(Number.NaN)).toMatchObject({
      tokens: 0,
      hardMinTokens: 4_000,
      warnBelowTokens: 8_000,
      shouldWarn: true,
      shouldBlock: true,
    });
  });

  it("adds a local-model hint to warning messages for localhost endpoints", () => {
    expect(
      formatContextWindowWarningMessage({
        provider: "lmstudio",
        modelId: "qwen3",
        guard: guardFor(6_000),
        runtimeBaseUrl: "http://127.0.0.1:1234/v1",
      }),
    ).toContain("local/self-hosted runs work best at 8000+ tokens");
  });

  it("does not add local-model hints for generic custom endpoints", () => {
    expect(
      formatContextWindowWarningMessage({
        provider: "custom",
        modelId: "hosted-proxy-model",
        guard: guardFor(6_000),
        runtimeBaseUrl: "https://models.example.com/v1",
      }),
    ).toBe("low context window: custom/hosted-proxy-model ctx=6000 (warn<8000) source=model");
  });

  it("adds a local-model hint to block messages for localhost endpoints", () => {
    expect(blockMessage(8_000, "http://127.0.0.1:11434/v1")).toContain(
      "This looks like a local model endpoint.",
    );
  });

  it("points model config block remediation at contextWindow/contextTokens", () => {
    expect(blockMessage(8_000, "http://127.0.0.1:11434/v1", "modelsConfig")).toContain(
      "Raise contextWindow/contextTokens or choose a larger model.",
    );
  });

  it("keeps block messages concise for public providers", () => {
    expect(blockMessage(3_000, "https://api.openai.com/v1")).toBe(
      `Model context window too small (3000 tokens; source=model). Minimum is 4000.`,
    );
  });
});
