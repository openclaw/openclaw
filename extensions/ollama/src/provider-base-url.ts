import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";

export function resolveOllamaBaseUrlForRun(params: {
  modelBaseUrl?: string;
  providerBaseUrl?: string;
}): string {
  return params.providerBaseUrl?.trim() || params.modelBaseUrl?.trim() || OLLAMA_DEFAULT_BASE_URL;
}

export function readProviderBaseUrl(
  provider: Partial<ModelProviderConfig> | undefined,
): string | undefined {
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
  const alternate = provider as Partial<ModelProviderConfig> & { baseURL?: unknown };
  if (
    Object.hasOwn(alternate, "baseURL") &&
    typeof alternate.baseURL === "string" &&
    alternate.baseURL.trim()
  ) {
    return alternate.baseURL.trim();
  }
  return undefined;
}
