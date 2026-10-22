import { describe, expect, it } from "vitest";
import { createModel } from "./model.test-support.js";
import {
  normalizeConfig,
  projectConfiguredModelRow,
  resolveThinkingProfile,
  resolveToolSearchMode,
} from "./provider-policy-api.js";
import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";

describe("ollama provider policy public artifact", () => {
  it.each([
    ["qwen3.5:9b", "http://model-host.internal:11434", "tools"],
    ["kimi-k2.5", "https://ollama.com/v1", false],
  ] as const)("selects Tool Search for %s at %s", (modelId, baseUrl, expected) => {
    expect(resolveToolSearchMode({ provider: "ollama", modelId, baseUrl, api: "ollama" })).toBe(
      expected,
    );
  });
  it("injects defaults so implicit discovery can run before validation", () => {
    expect(normalizeConfig({ provider: "ollama", providerConfig: {} })).toStrictEqual({
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      models: [],
    });
  });

  it("preserves explicit Ollama config values", () => {
    const providerConfig = {
      baseUrl: "http://ollama.internal:11434",
      models: [createModel("llama3.2", "Llama 3.2")],
    };
    const expected = structuredClone(providerConfig);
    expect(normalizeConfig({ provider: "ollama", providerConfig })).toStrictEqual(expected);
  });

  it("ignores other providers", () => {
    expect(normalizeConfig({ provider: "openai", providerConfig: {} })).toStrictEqual({});
  });

  it.each([
    [" OLLAMA-CLOUD ", "qwen3.5:9b", "ollama", OLLAMA_DEFAULT_BASE_URL, null],
    ["openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1", undefined],
  ] as const)("projects configured rows for %s", (provider, modelId, api, baseUrl, expected) => {
    expect(
      projectConfiguredModelRow({
        provider,
        modelId,
        model: {
          ...createModel(modelId, modelId, { reasoning: true }),
          provider: provider.trim().toLowerCase(),
          api,
          baseUrl,
        },
      }),
    ).toBe(expected);
  });

  it("exposes full native effort for cloud models without projected metadata", () => {
    expect(resolveThinkingProfile({ provider: "ollama-cloud", modelId: "glm-5.3" }).levels).toEqual(
      ["off", "low", "medium", "high", "max"].map((id) => ({ id })),
    );
  });

  it("uses the implicit native API for discovered tiers", () => {
    expect(
      resolveThinkingProfile({
        provider: "ollama",
        modelId: "custom-thinking-model",
        api: undefined,
        reasoning: true,
        thinkingLevelMap: { minimal: "minimal", xhigh: "xhigh" },
      }).levels.map(({ id }) => id),
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("does not invent effort levels for catalog-light cloud models", () => {
    expect(
      resolveThinkingProfile({ provider: "ollama-cloud", modelId: "minimax-m2.7" }).levels,
    ).toEqual([{ id: "off" }]);
  });
});
