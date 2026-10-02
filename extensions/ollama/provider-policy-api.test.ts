import { describe, expect, it } from "vitest";
import { createModel } from "./model.test-support.js";
import {
  normalizeConfig,
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
  const explicit = {
    baseUrl: "http://ollama.internal:11434",
    models: [createModel("llama3.2", "Llama 3.2")],
  };
  it.each([
    ["ollama", {}, { baseUrl: OLLAMA_DEFAULT_BASE_URL, models: [] }],
    ["ollama", explicit, structuredClone(explicit)],
    ["openai", {}, {}],
  ] as const)("normalizes %s configuration %j", (provider, providerConfig, expected) => {
    expect(normalizeConfig({ provider, providerConfig })).toStrictEqual(expected);
  });

  it.each([
    [{ provider: "ollama-cloud", modelId: "glm-5.3" }, "off low medium high max"],
    [
      {
        provider: "ollama",
        modelId: "custom-thinking-model",
        api: undefined,
        reasoning: true,
        thinkingLevelMap: { minimal: "minimal", xhigh: "xhigh" },
      },
      "off minimal low medium high xhigh max",
    ],
    [{ provider: "ollama-cloud", modelId: "minimax-m2.7" }, "off"],
  ] as const)("resolves thinking levels for %j", (context, expected) => {
    expect(resolveThinkingProfile(context).levels).toEqual(
      expected.split(" ").map((id) => ({ id })),
    );
  });
});
