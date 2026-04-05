import { MODEL_APIS } from "../config/types.models.js";
import {
  applyProviderNativeStreamingUsageCompatWithPlugin,
  normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const GENERIC_PROVIDER_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);
function resolveProviderPluginLookupKey(providerKey: string, provider?: ProviderConfig): string {
  const api = typeof provider?.api === "string" ? provider.api.trim() : "";
  if (
    api &&
    MODEL_APIS.includes(api as (typeof MODEL_APIS)[number]) &&
    !GENERIC_PROVIDER_APIS.has(api)
  ) {
    return api;
  }
  return providerKey;
}

export function applyNativeStreamingUsageCompat(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let changed = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
    const nextProvider =
      applyProviderNativeStreamingUsageCompatWithPlugin({
        provider: runtimeProviderKey,
        context: {
          provider: providerKey,
          providerConfig: provider,
        },
      }) ?? provider;
    nextProviders[providerKey] = nextProvider;
    changed ||= nextProvider !== provider;
  }

  return changed ? nextProviders : providers;
}

export function normalizeProviderSpecificConfig(
  providerKey: string,
  provider: ProviderConfig,
): ProviderConfig {
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
  const normalized =
    normalizeProviderConfigWithPlugin({
      provider: runtimeProviderKey,
      context: {
        provider: providerKey,
        providerConfig: provider,
      },
    }) ?? undefined;
  if (normalized && normalized !== provider) {
    return normalized;
  }
  return provider;
}

export function resolveProviderConfigApiKeyResolver(
  providerKey: string,
  provider?: ProviderConfig,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider).trim();
  return (env) =>
    resolveProviderConfigApiKeyWithPlugin({
      provider: runtimeProviderKey,
      context: {
        provider: providerKey,
        env,
      },
    });
}
