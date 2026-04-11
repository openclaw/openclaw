import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

/**
 * Reads the base URL from a provider config, accepting both `baseUrl` (canonical)
 * and `baseURL` (OpenAI SDK convention with uppercase URL).
 *
 * Users familiar with the OpenAI SDK often write `baseURL` while the OpenClaw
 * config schema uses `baseUrl`. Accept both spellings so remote Ollama hosts
 * are not silently ignored and requests do not fall back to localhost:11434.
 *
 * @param provider - The provider config object
 * @returns The base URL string if found, undefined otherwise
 */
export function readProviderBaseUrl(provider: ModelProviderConfig | undefined): string | undefined {
  if (!provider) {
    return undefined;
  }

  // Prefer canonical baseUrl (lowercase)
  // Use Object.hasOwn to avoid prototype pollution (CWE-1321)
  if (
    Object.hasOwn(provider, "baseUrl") &&
    typeof provider.baseUrl === "string" &&
    provider.baseUrl.trim()
  ) {
    return provider.baseUrl.trim();
  }

  // Fall back to baseURL (uppercase, OpenAI SDK convention)
  // Use Object.hasOwn to avoid prototype pollution (CWE-1321)
  const providerWithAlternate = provider as ModelProviderConfig & { baseURL?: unknown };
  if (
    Object.hasOwn(providerWithAlternate, "baseURL") &&
    typeof providerWithAlternate.baseURL === "string" &&
    providerWithAlternate.baseURL.trim()
  ) {
    return providerWithAlternate.baseURL.trim();
  }

  return undefined;
}
