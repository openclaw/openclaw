import { resolveBedrockConfigApiKey } from "../plugin-sdk/amazon-bedrock.js";
import {
  normalizeGoogleProviderConfig,
  shouldNormalizeGoogleProviderConfig,
} from "../plugin-sdk/google.js";
import {
  applyProviderNativeStreamingUsageCompatWithPlugin,
  normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin,
  resolveProviderRuntimePlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

export function applyNativeStreamingUsageCompat(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let changed = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    const nextProvider =
      applyProviderNativeStreamingUsageCompatWithPlugin({
        provider: providerKey,
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
  const normalized =
    normalizeProviderConfigWithPlugin({
      provider: providerKey,
      context: {
        provider: providerKey,
        providerConfig: provider,
      },
    }) ?? undefined;
  if (normalized) {
    return normalized;
  }
  if (shouldNormalizeGoogleProviderConfig(providerKey, provider)) {
    return normalizeGoogleProviderConfig(providerKey, provider);
  }
  return provider;
}

export function resolveProviderConfigApiKeyResolver(
  providerKey: string,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
  if (providerKey.trim() === "amazon-bedrock") {
    return (env) => {
      const resolved = resolveBedrockConfigApiKey(env);
      return resolved?.trim() || undefined;
    };
  }
  if (!resolveProviderRuntimePlugin({ provider: providerKey })?.resolveConfigApiKey) {
    return undefined;
  }
  return (env) => {
    const resolved = resolveProviderConfigApiKeyWithPlugin({
      provider: providerKey,
      env,
      context: {
        provider: providerKey,
        env,
      },
    });
    return resolved?.trim() || undefined;
  };
}
