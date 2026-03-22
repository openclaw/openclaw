import {
  discoverKilocodeModels,
  type ModelProviderConfig,
  KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";

export function buildKilocodeProvider(): ModelProviderConfig {
  return {
    baseUrl: KILOCODE_BASE_URL,
    api: "openai-completions",
    models: KILOCODE_MODEL_CATALOG.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: KILOCODE_DEFAULT_COST,
      contextWindow: model.contextWindow ?? KILOCODE_DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? KILOCODE_DEFAULT_MAX_TOKENS,
    })),
  };
}

export async function buildKilocodeProviderWithDiscovery(): Promise<ModelProviderConfig> {
  const models = await discoverKilocodeModels();
  return {
    baseUrl: KILOCODE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
