import { resolveBedrockConfigApiKey } from "../../extensions/amazon-bedrock/api.js";
import {
  normalizeGoogleProviderConfig,
  shouldNormalizeGoogleProviderConfig,
} from "../../extensions/google/api.js";
import {
  applyProviderNativeStreamingUsageCompatWithPlugin,
  normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin,
  resolveProviderRuntimePlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

function resolveProviderPluginLookupKey(providerKey: string, provider?: ProviderConfig): string {
  const api = typeof provider?.api === "string" ? provider.api.trim() : "";
  return api || providerKey;
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
  if (shouldNormalizeGoogleProviderConfig(providerKey, provider)) {
    return normalizeGoogleProviderConfig(providerKey, provider);
  }
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
  if (providerKey.trim() === "amazon-bedrock") {
    return (env) => {
      const resolved = resolveBedrockConfigApiKey(env);
      return resolved?.trim() || undefined;
    };
  }
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
  if (!resolveProviderRuntimePlugin({ provider: runtimeProviderKey })?.resolveConfigApiKey) {
    return undefined;
  }
  return (env) => {
    const resolved = resolveProviderConfigApiKeyWithPlugin({
      provider: runtimeProviderKey,
      env,
      context: {
        provider: providerKey,
        env,
      },
    });
    return resolved?.trim() || undefined;
  };
}
