import {
    DEEPINFRA_BASE_URL,
    DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    DEEPINFRA_DEFAULT_COST,
    DEEPINFRA_DEFAULT_MAX_TOKENS,
    DEEPINFRA_MODEL_CATALOG,
} from "../providers/deepinfra-shared.ts";

import { discoverDeepInfraModels } from "./deepinfra-models.js";

export async function buildDeepInfraProviderWithDiscovery(): Promise<ProviderConfig> {
  const models = await discoverDeepInfraModels();
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models,
  };
}

export function buildDeepInfraStaticProvider(): ProviderConfig {
    return {
        baseUrl: DEEPINFRA_BASE_URL,
        api: "openai-completions",
        models: DEEPINFRA_MODEL_CATALOG.map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: model.input,
          cost: DEEPINFRA_DEFAULT_COST,
          contextWindow: model.contextWindow ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
          maxTokens: model.maxTokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
    })),
  };
}
