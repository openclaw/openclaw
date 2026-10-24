import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-types";
import { expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

function createModel(compat?: ModelDefinitionConfig["compat"]): ModelDefinitionConfig {
  return {
    id: "synthetic-reasoning-model",
    name: "Synthetic reasoning model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
    ...(compat ? { compat } : {}),
  };
}

function createProvider(models: ModelDefinitionConfig[]): ModelProviderConfig {
  return { baseUrl: "http://localhost:1234/v1", models };
}

it("normalizes saved reasoning metadata without changing endpoint or transport settings", () => {
  const legacyModel = createModel({
    codeMode: "preferred",
    supportsTools: true,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ["off", "on"],
    reasoningEffortMap: { off: "off", high: "on" },
  });
  const unchangedModel = createModel({ codeMode: "capable" });
  const providerConfig: ModelProviderConfig = {
    baseUrl: "http://lmstudio.internal:1234/api/v1/",
    api: "openai-completions",
    headers: { "X-Synthetic-Provider": "synthetic" },
    request: { allowPrivateNetwork: false, headers: { "X-Synthetic-Request": "synthetic" } },
    params: { preserveCustomSetting: true },
    models: [legacyModel, unchangedModel],
  };
  const { request, headers } = providerConfig;
  const normalized = normalizeConfig({ provider: "lmstudio", providerConfig });
  const compat = {
    ...legacyModel.compat,
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    reasoningEffortMap: {
      off: "off",
      none: "off",
      minimal: "on",
      low: "on",
      medium: "on",
      high: "on",
      xhigh: "on",
      adaptive: "on",
      max: "on",
    },
  };
  expect(normalized).toEqual({
    ...providerConfig,
    models: [{ ...legacyModel, compat }, unchangedModel],
  });
  expect(normalized.request).toBe(request);
  expect(normalized.headers).toBe(headers);
  expect(normalized.models[1]).toBe(unchangedModel);
  expect(legacyModel.compat?.supportedReasoningEfforts).toEqual(["off", "on"]);
});

it("preserves provider and model identities when saved reasoning is already canonical", () => {
  const models = [
    createModel({
      supportedReasoningEfforts: ["none", "low", "high"],
      reasoningEffortMap: { off: "none", high: "high" },
    }),
    createModel(),
  ];
  const providerConfig = createProvider(models);
  expect(normalizeConfig({ provider: "lmstudio", providerConfig })).toBe(providerConfig);
  expect(providerConfig.models).toBe(models);
});

it("ignores unrelated providers", () => {
  const model = createModel({ supportedReasoningEfforts: ["off", "on"] });
  const providerConfig = createProvider([model]);
  expect(normalizeConfig({ provider: "openai", providerConfig })).toBe(providerConfig);
});

it.each([[], "invalid"])("preserves malformed compatibility metadata: %j", (compat) => {
  const model = { ...createModel(), compat } as unknown as ModelDefinitionConfig;
  const providerConfig = createProvider([model]);
  expect(normalizeConfig({ provider: "lmstudio", providerConfig })).toBe(providerConfig);
  expect(providerConfig.models[0]).toBe(model);
});

it("leaves partial provider declarations without model rows untouched", () => {
  const providerConfig = { baseUrl: "http://localhost:1234/v1" } as ModelProviderConfig;

  expect(normalizeConfig({ provider: "lmstudio", providerConfig })).toBe(providerConfig);
});
