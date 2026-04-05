import { resolveBedrockConfigApiKey } from "../../extensions/amazon-bedrock/discovery.js";
import { resolveAnthropicVertexConfigApiKey } from "../../extensions/anthropic-vertex/region.js";
import { normalizeGoogleProviderConfig } from "../../extensions/google/api.js";
import { MODEL_APIS } from "../config/types.models.js";
import { resolveMantleBearerToken } from "../plugin-sdk/amazon-bedrock-mantle.js";
import {
  applyProviderNativeStreamingUsageCompatWithPlugin,
  normalizeProviderConfigWithPlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const GENERIC_PROVIDER_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);
const PROVIDERS_WITH_RUNTIME_NORMALIZE_CONFIG = new Set<string>(["anthropic"]);
const GOOGLE_PROVIDER_KEYS = new Set<string>(["google", "google-antigravity", "google-vertex"]);

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
  if (GOOGLE_PROVIDER_KEYS.has(runtimeProviderKey)) {
    const normalized = normalizeGoogleProviderConfig(providerKey, provider);
    if (normalized !== provider) {
      return normalized;
    }
  }
  if (!PROVIDERS_WITH_RUNTIME_NORMALIZE_CONFIG.has(runtimeProviderKey)) {
    return provider;
  }
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
  if (runtimeProviderKey === "amazon-bedrock") {
    return (env) => resolveBedrockConfigApiKey(env)?.trim() || undefined;
  }
  if (runtimeProviderKey === "anthropic-vertex") {
    return (env) => resolveAnthropicVertexConfigApiKey(env)?.trim() || undefined;
  }
  if (runtimeProviderKey === "amazon-bedrock-mantle") {
    return (env) =>
      resolveMantleBearerToken(env)?.trim() ? "AWS_BEARER_TOKEN_BEDROCK" : undefined;
  }
  return undefined;
}
