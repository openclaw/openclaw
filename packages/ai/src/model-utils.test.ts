import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "./model-utils.js";
import type { Model } from "./types.js";

function makeModel(
  thinkingLevelMap: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.com",
    reasoning: true,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  };
}

describe("clampThinkingLevel", () => {
  it("honors a mapped logical Max opt-out on the transport alias", () => {
    const model = makeModel(
      { max: null },
      {
        api: "openclaw-openai-responses-transport",
        compat: {
          supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
          reasoningEffortMap: { high: "ProviderLow", MAX: "ProviderHigh" },
        },
      },
    );

    expect(getSupportedThinkingLevels(model)).not.toContain("max");
  });

  it.each(["anthropic-messages"] as const)("does not apply OpenAI compat levels to %s", (api) => {
    const model = makeModel(undefined, {
      api,
      compat: { supportedReasoningEfforts: ["max"] },
    });
    expect(clampThinkingLevel(model, "max")).toBe("high");
  });

  it.each([
    { api: "openclaw-openai-completions-transport", compat: { supportsReasoningEffort: false } },
  ])(
    "does not expose mapped extended levels when scalar effort is disabled: $api $compat",
    ({ api, compat }) => {
      const model = makeModel({ xhigh: "xhigh", max: "max" }, { api, compat });

      expect(getSupportedThinkingLevels(model)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
      ]);
      expect(clampThinkingLevel(model, "xhigh")).toBe("high");
      expect(clampThinkingLevel(model, "max")).toBe("high");
    },
  );

  it("downgrades explicit extended-level opt-outs", () => {
    expect(clampThinkingLevel(makeModel({ xhigh: null, max: "max" }), "xhigh")).toBe("high");
  });

  it("honors canonical Fable capabilities when catalog reasoning is stale", () => {
    const model = makeModel(undefined, {
      id: "company-fable",
      api: "anthropic-messages",
      provider: "microsoft-foundry",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });
});
