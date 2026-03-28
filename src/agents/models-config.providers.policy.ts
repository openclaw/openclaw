import { resolveBedrockConfigApiKey } from "../plugin-sdk/amazon-bedrock.js";
import { resolveAnthropicVertexConfigApiKey } from "../plugin-sdk/anthropic-vertex.js";
import {
  normalizeGoogleProviderConfig,
  shouldNormalizeGoogleProviderConfig,
} from "../plugin-sdk/google.js";
import { applyModelStudioNativeStreamingUsageCompat } from "../plugin-sdk/modelstudio.js";
import { applyMoonshotNativeStreamingUsageCompat } from "../plugin-sdk/moonshot.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const NATIVE_STREAMING_USAGE_COMPAT: Record<string, (provider: ProviderConfig) => ProviderConfig> =
  {
    moonshot: applyMoonshotNativeStreamingUsageCompat,
    modelstudio: applyModelStudioNativeStreamingUsageCompat,
  };

const PROVIDER_CONFIG_API_KEY_RESOLVERS: Partial<
  Record<string, (env: NodeJS.ProcessEnv) => string | undefined>
> = {
  "amazon-bedrock": resolveBedrockConfigApiKey,
  "anthropic-vertex": resolveAnthropicVertexConfigApiKey,
};

export function applyNativeStreamingUsageCompat(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let changed = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    const nextProvider = NATIVE_STREAMING_USAGE_COMPAT[providerKey]?.(provider) ?? provider;
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
  return provider;
}

export function resolveProviderConfigApiKeyResolver(
  providerKey: string,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
  return PROVIDER_CONFIG_API_KEY_RESOLVERS[providerKey];
}
