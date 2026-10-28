import type { z } from "zod";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";
import type { ModelsConfigSchema } from "../config/zod-schema.core.js";

export function modelDefinition(
  id: string,
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

export function providerEntry(
  baseUrl: string,
  options: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return { baseUrl, models: [], ...options };
}

export function configForProviders<
  Providers extends NonNullable<NonNullable<z.input<typeof ModelsConfigSchema>>["providers"]>,
>(providers: Providers) {
  return { models: { providers } };
}

export function configFor(
  provider: string,
  baseUrl = "",
  options: Partial<ModelProviderConfig> = {},
) {
  return configForProviders({ [provider]: providerEntry(baseUrl, options) });
}

export function providerConfig(provider: string, entry: Partial<ModelProviderConfig>) {
  return configFor(provider, entry.baseUrl ?? "", entry);
}

export function createPlatformAuthRoute() {
  return {
    provider: "openai",
    modelId: "gpt-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authRequirement: "api-key",
    requestTransportOverrides: "none",
  } as const;
}
