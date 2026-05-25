import { getModels, getProviders } from "../../llm/models.js";
import type { KnownProvider, Model } from "../../llm/types.js";

const builtInProviders = new Set<string>(getProviders());
const providerDefaults = new Map<string, { api: string; baseUrl: string }>();

export function listBuiltInModelProviders(): string[] {
  return getProviders();
}

export function isBuiltInModelProvider(provider: string): boolean {
  return builtInProviders.has(provider);
}

export function listBuiltInModelsForProvider(provider: string): Model[] {
  if (!isBuiltInModelProvider(provider)) {
    return [];
  }
  return getModels(provider as KnownProvider) as Model[];
}

export function getBuiltInProviderModelDefaults(
  provider: string,
): { api: string; baseUrl: string } | undefined {
  const cached = providerDefaults.get(provider);
  if (cached) {
    return cached;
  }

  const [model] = listBuiltInModelsForProvider(provider);
  if (!model) {
    return undefined;
  }

  const defaults = { api: model.api, baseUrl: model.baseUrl };
  providerDefaults.set(provider, defaults);
  return defaults;
}
