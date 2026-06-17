// Ollama provider module implements model/runtime integration.
import type { ModelProviderConfigInput } from "openclaw/plugin-sdk/config-types";

export function readProviderBaseUrl(
  provider: ModelProviderConfigInput | undefined,
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
  const alternate = provider as ModelProviderConfigInput & { baseURL?: unknown };
  if (
    Object.hasOwn(alternate, "baseURL") &&
    typeof alternate.baseURL === "string" &&
    alternate.baseURL.trim()
  ) {
    return alternate.baseURL.trim();
  }
  return undefined;
}
