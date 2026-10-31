import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import plugin from "./index.js";

it("preserves config and model fields but projects only transport fields", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  const providerConfig = {
    api: "openai-completions" as const,
    baseUrl: "https://opencode.ai/zen/",
    models: [],
    headers: { "x-synthetic": "retained" },
  };
  const model: ProviderRuntimeModel = {
    ...providerConfig,
    provider: "opencode",
    id: "synthetic-model",
    name: "Synthetic model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 100,
  };
  expect(provider.normalizeConfig?.({ provider: "opencode", providerConfig })).toEqual({
    ...providerConfig,
    baseUrl: "https://opencode.ai/zen/v1",
  });
  expect(
    provider.normalizeResolvedModel?.({ provider: "opencode", modelId: model.id, model }),
  ).toEqual({
    ...model,
    baseUrl: "https://opencode.ai/zen/v1",
  });
  expect(provider.normalizeTransport?.({ ...model, config: {} })).toEqual({
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/v1",
  });
  expect(providerConfig.baseUrl).toBe("https://opencode.ai/zen/");
  expect(model.baseUrl).toBe("https://opencode.ai/zen/");
});

it.each([undefined, "https://proxy.example.test/v1", "https://opencode.ai/zen/v1"])(
  "returns no transport patch for unchanged or unrecognized URL %s",
  async (baseUrl) => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(
      provider.normalizeTransport?.({ provider: "opencode", api: "openai-completions", baseUrl }),
    ).toBeUndefined();
  },
);
