// Ollama provider module implements model/runtime integration.
<<<<<<< HEAD
import type {
  ModelProviderConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

/**
 * Provider config input type — partial config without required `models`.
 * Replaces the deprecated `openclaw/plugin-sdk/config-types` import.
 */
type OllamaProviderConfigInput = Omit<Partial<ModelProviderConfig>, "models"> & {
  models?: ModelDefinitionConfig[];
};

export function readProviderBaseUrl(
  provider: OllamaProviderConfigInput | undefined,
): string | undefined {
=======
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export function readProviderBaseUrl(provider: ModelProviderConfig | undefined): string | undefined {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!provider) {
    return undefined;
  }
  if (
    Object.hasOwn(provider, "baseUrl") &&
    typeof provider.baseUrl === "string" &&
    provider.baseUrl.trim()
  ) {
    return provider.baseUrl.trim();
  }
<<<<<<< HEAD
  const alternate = provider as OllamaProviderConfigInput & { baseURL?: unknown };
=======
  const alternate = provider as ModelProviderConfig & { baseURL?: unknown };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (
    Object.hasOwn(alternate, "baseURL") &&
    typeof alternate.baseURL === "string" &&
    alternate.baseURL.trim()
  ) {
    return alternate.baseURL.trim();
  }
  return undefined;
}
