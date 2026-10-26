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
  const resolve = (overrides: Partial<Parameters<typeof resolveContextWindowInfo>[0]> = {}) =>
    resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      defaultTokens: 200_000,
      ...overrides,
    });

  it.each([
    [{ modelContextWindow: 6_000 }, "model", 6_000, true],
    [{ defaultTokens: Number.NaN }, "default", 8_000, false],
  ] as const)("resolves and guards %j", (options, source, tokens, shouldWarn) => {
    const info = resolve(options);
    expect(info).toEqual({ source, tokens });
    expect(evaluateContextWindowGuard({ info })).toMatchObject({ shouldWarn, shouldBlock: false });
  });

  it.each([
    ["anthropic", "claude-sonnet-4-6", "claude-sonnet-4-6", 200_000, Infinity, 200_000],
    ["custom", "tiny", "tiny", 0.5, 16_000, 16_000],
    ["openrouter", "tiny", "openrouter/tiny", 1_000_000, 936_000, 936_000],
  ] as const)(
    "resolves configured context limits for %s/%s as %s",
    (provider, configId, modelId, contextWindow, contextTokens, expected) => {
      expect(
        resolve({
          cfg: modelConfig(provider, configId, { contextWindow, contextTokens }),
          provider,
          modelId,
          modelContextTokens: 8_000,
          modelContextWindow: 8_000,
        }),
      ).toEqual({ source: "modelsConfig", tokens: expected });
    },
  );

  it("blocks invalid guard token counts instead of silently passing", () => {
    expect(guardFor(Number.NaN)).toMatchObject({
      tokens: 0,
      hardMinTokens: 4_000,
      warnBelowTokens: 8_000,
      shouldWarn: true,
      shouldBlock: true,
    });
  });

  it.each([
    ["warning", true, "model", /local\/self-hosted runs work best at 8000\+ tokens/],
    ["warning", false, "model", "low context window: custom/m ctx=6000 (warn<8000) source=model"],
    ["block", true, "model", /This looks like a local model endpoint\./],
    [
      "block",
      true,
      "modelsConfig",
      /Raise contextWindow\/contextTokens or choose a larger model\./,
    ],
    [
      "block",
      false,
      "model",
      "Model context window too small (3000 tokens; source=model). Minimum is 4000.",
    ],
  ] as const)("formats %s remediation (local=%s, source=%s)", (kind, local, source, expected) => {
    const message = (
      kind === "warning" ? formatContextWindowWarningMessage : formatContextWindowBlockMessage
    )({
      provider: "custom",
      modelId: "m",
      runtimeBaseUrl: local ? "http://127.0.0.1:11434/v1" : "https://models.example.com/v1",
      guard: guardFor(kind === "warning" ? 6_000 : local ? 8_000 : 3_000, source),
    });
    if (typeof expected === "string") {
      expect(message).toBe(expected);
    } else {
      expect(message).toMatch(expected);
    }
  });
});
