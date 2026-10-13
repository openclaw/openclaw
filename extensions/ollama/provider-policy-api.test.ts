// Ollama tests cover provider policy api plugin behavior.
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
    {
      provider: "ollama",
      modelId: "qwen3.5:9b",
      baseUrl: "http://model-host.internal:11434",
      expected: "tools",
    },
    { provider: "ollama", modelId: "kimi-k2.5", baseUrl: "https://ollama.com/v1", expected: false },
  ])("selects Tool Search for $provider/$modelId at $baseUrl", ({ expected, ...context }) => {
    expect(resolveToolSearchMode({ ...context, api: "ollama" })).toBe(expected);
  });
  it("injects defaults so implicit discovery can run before validation", () => {
    expect(
      normalizeConfig({
        provider: "ollama",
        providerConfig: {},
      }),
    ).toStrictEqual({
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      models: [],
    });
  });

  it("preserves explicit Ollama config values", () => {
    const models = [createModel("llama3.2", "Llama 3.2")];

    expect(
      normalizeConfig({
        provider: "ollama",
        providerConfig: {
          baseUrl: "http://ollama.internal:11434",
          models,
        },
      }),
    ).toStrictEqual({
      baseUrl: "http://ollama.internal:11434",
      models,
    });
  });

  it("ignores other providers", () => {
    expect(
      normalizeConfig({
        provider: "openai",
        providerConfig: {},
      }),
    ).toStrictEqual({});
  });

  it.each([" OLLAMA-CLOUD "])("skips runtime row normalization for %s", (provider) => {
    expect(
      projectConfiguredModelRow({
        provider,
        modelId: "qwen3.5:9b",
        model: {
          ...createModel("qwen3.5:9b", "Qwen 3.5 9B", { reasoning: true }),
          provider: provider.trim().toLowerCase(),
          api: "ollama",
          baseUrl: OLLAMA_DEFAULT_BASE_URL,
        },
      }),
    ).toBeNull();
  });

  it("keeps unrelated providers on the runtime normalization path", () => {
    expect(
      projectConfiguredModelRow({
        provider: "openai",
        modelId: "gpt-5.5",
        model: {
          ...createModel("gpt-5.5", "GPT-5.5", { reasoning: true }),
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toBeUndefined();
  });

  it.each(["glm-5.3"])(
    "exposes full native effort for cloud model %s when lightweight projections omit metadata",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "ollama-cloud", modelId }).levels).toEqual([
        { id: "off" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "max" },
      ]);
    },
  );

  it.each([undefined])("uses the implicit native API for discovered tiers (%s)", (api) => {
    const profile = resolveThinkingProfile({
      provider: "ollama",
      modelId: "custom-thinking-model",
      api,
      reasoning: true,
      thinkingLevelMap: { minimal: "minimal", xhigh: "xhigh" },
    });
    expect(profile.levels.map(({ id }) => id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it.each(["minimax-m2.7"])(
    "does not invent effort levels for catalog-light cloud model %s",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "ollama-cloud", modelId }).levels).toEqual([
        { id: "off" },
      ]);
    },
  );
});
