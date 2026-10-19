import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
  OpenClawConfig,
} from "../config/types.js";

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

export function configForProviders(providers: Record<string, ModelProviderConfig>) {
  return { models: { providers } } satisfies OpenClawConfig;
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
