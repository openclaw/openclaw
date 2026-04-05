import { MODEL_APIS } from "../config/types.models.js";
import { resolveMantleBearerToken } from "../plugin-sdk/amazon-bedrock-mantle.js";
import {
  applyProviderNativeStreamingUsageCompatWithPlugin,
  normalizeProviderConfigWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolvePluginSetupProvider } from "../plugins/setup-registry.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const GENERIC_PROVIDER_APIS = new Set<string>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);
const PROVIDERS_WITH_RUNTIME_NORMALIZE_CONFIG = new Set<string>(["anthropic"]);

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
  const setupProvider = resolvePluginSetupProvider({
    provider: resolveProviderPluginLookupKey(providerKey, provider),
  });
  const setupNormalized = setupProvider?.normalizeConfig?.({
    provider: providerKey,
    providerConfig: provider,
  });
  if (setupNormalized && setupNormalized !== provider) {
    return setupNormalized;
  }
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
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
  const setupProvider = resolvePluginSetupProvider({
    provider: resolveProviderPluginLookupKey(providerKey, provider),
  });
  const resolveSetupConfigApiKey = setupProvider?.resolveConfigApiKey;
  if (resolveSetupConfigApiKey) {
    return (env) => {
      const resolved = resolveSetupConfigApiKey({
        provider: providerKey,
        env,
      });
      return resolved?.trim() || undefined;
    };
  }
  const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider).trim();
  if (runtimeProviderKey === "amazon-bedrock-mantle") {
    return (env) =>
      resolveMantleBearerToken(env)?.trim() ? "AWS_BEARER_TOKEN_BEDROCK" : undefined;
  }
  return undefined;
}
