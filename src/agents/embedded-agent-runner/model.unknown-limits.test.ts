import { expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { modelCatalogRowToEntry } from "../model-catalog-entry.js";
import { applyConfiguredProviderOverrides } from "./model.configured-overrides.js";
import { completeInlineProviderModel } from "./model.inline-provider.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

const provider = "fixture";
const baseUrl = "https://models.example";
const definition = {
  id: "unknown",
  name: "Unknown",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  api: "anthropic-messages",
} satisfies ModelDefinitionConfig;
it("retains unknown inline facts and keeps the local context budget separate", () => {
  const model = completeInlineProviderModel(
    { ...definition, provider, baseUrl, contextTokens: 4096 },
    { api: "anthropic-messages", baseUrl, models: [] },
  );
  expect(model).toMatchObject({
    maxTokens: undefined,
    contextWindow: undefined,
    contextTokens: 4096,
  });
  expect(model).not.toHaveProperty("contextWindowSource");
});
it.each([undefined, 128, 512])(
  "intersects configured output budget with qualified ceiling %s",
  (maxTokens) => {
    const discoveredModel = {
      ...definition,
      provider,
      baseUrl,
      api: "anthropic-messages" as const,
      maxTokens,
    };
    const providerConfig = {
      baseUrl,
      api: "anthropic-messages" as const,
      models: [{ ...definition, maxTokens: 256, contextTokens: 4096 }],
    };
    const model = applyConfiguredProviderOverrides({
      provider,
      discoveredModel,
      providerConfig,
      modelId: definition.id,
      manifestAlias: { provider },
      runtimeHooks: createProviderRuntimeTestMock({ handledDynamicProviders: [] }),
    });
    expect(model?.maxTokens).toBe(maxTokens === undefined ? 256 : Math.min(256, maxTokens));
    expect(model?.maxTokensSource).toBe("configured");
    expect(model?.contextWindow).toBeUndefined();
    expect(model?.contextTokens).toBe(4096);
  },
);
it.each([{ baseUrl: "https://proxy.example" }, { api: "openai-completions" as const }])(
  "does not borrow an output ceiling after a transport override %j",
  (route) => {
    const model = applyConfiguredProviderOverrides({
      provider,
      modelId: definition.id,
      discoveredModel: {
        ...definition,
        provider,
        baseUrl,
        api: "anthropic-messages",
        maxTokens: 128,
      },
      providerConfig: {
        baseUrl,
        api: "anthropic-messages",
        ...route,
        models: [{ ...definition, ...route, maxTokens: 256 }],
      },
      manifestAlias: { provider },
      runtimeHooks: createProviderRuntimeTestMock({ handledDynamicProviders: [] }),
    });
    expect(model?.maxTokens).toBe(256);
  },
);
it.each([undefined, 1024, 8192])(
  "does not advertise a local context budget as capacity %s",
  (contextWindow) => {
    const entry = modelCatalogRowToEntry({
      provider,
      id: definition.id,
      name: definition.name,
      contextTokens: 4096,
      contextWindow,
    });
    expect(entry.contextWindow).toBe(contextWindow);
    expect(entry.contextTokens).toBe(
      contextWindow === undefined ? 4096 : Math.min(4096, contextWindow),
    );
  },
);
