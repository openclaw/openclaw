import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveBedrockConfigApiKey } from "../plugin-sdk/amazon-bedrock.js";
import { resolveAnthropicVertexConfigApiKey } from "../plugin-sdk/anthropic-vertex.js";
import {
  normalizeGoogleProviderConfig,
  shouldNormalizeGoogleProviderConfig,
} from "../plugin-sdk/google.js";
import { applyModelStudioNativeStreamingUsageCompat } from "../plugin-sdk/modelstudio.js";
import { applyMoonshotNativeStreamingUsageCompat } from "../plugin-sdk/moonshot.js";
import { isRecord } from "../utils.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
export * from "./models-config.providers.static.js";
import {
  resolveNonEnvSecretRefApiKeyMarker,
  resolveNonEnvSecretRefHeaderValueMarker,
  resolveEnvSecretRefHeaderValueMarker,
} from "./model-auth-markers.js";
export { resolveImplicitProviders } from "./models-config.providers.implicit.js";
import type { ProviderConfig, SecretDefaults } from "./models-config.providers.secrets.js";
import {
  normalizeConfiguredProviderApiKey,
  normalizeHeaderValues,
  normalizeResolvedEnvApiKey,
  resolveApiKeyFromProfiles,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secrets.js";
export type {
  ProfileApiKeyResolution,
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
  SecretDefaults,
} from "./models-config.providers.secrets.js";
export { resolveOllamaApiBase } from "../plugin-sdk/ollama-surface.js";
export { normalizeGoogleModelId } from "../plugin-sdk/google.js";
export { normalizeXaiModelId } from "../plugin-sdk/xai.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

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

function normalizeProviderSpecificConfig(
  providerKey: string,
  provider: ProviderConfig,
): ProviderConfig {
  if (shouldNormalizeGoogleProviderConfig(providerKey, provider)) {
    return normalizeGoogleProviderConfig(providerKey, provider);
  }
  return provider;
}

function normalizeSourceProviderLookup(
  providers: ModelsConfig["providers"] | undefined,
): Record<string, ProviderConfig> {
  if (!providers) {
    return {};
  }
  const out: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || !isRecord(provider)) {
      continue;
    }
    out[normalizedKey] = provider;
  }
  return out;
}

function resolveSourceManagedApiKeyMarker(params: {
  sourceProvider: ProviderConfig | undefined;
  sourceSecretDefaults: SecretDefaults | undefined;
}): string | undefined {
  const sourceApiKeyRef = resolveSecretInputRef({
    value: params.sourceProvider?.apiKey,
    defaults: params.sourceSecretDefaults,
  }).ref;
  if (!sourceApiKeyRef || !sourceApiKeyRef.id.trim()) {
    return undefined;
  }
  return sourceApiKeyRef.source === "env"
    ? sourceApiKeyRef.id.trim()
    : resolveNonEnvSecretRefApiKeyMarker(sourceApiKeyRef.source);
}

function resolveSourceManagedHeaderMarkers(params: {
  sourceProvider: ProviderConfig | undefined;
  sourceSecretDefaults: SecretDefaults | undefined;
}): Record<string, string> {
  const sourceHeaders = isRecord(params.sourceProvider?.headers)
    ? (params.sourceProvider.headers as Record<string, unknown>)
    : undefined;
  if (!sourceHeaders) {
    return {};
  }
  const markers: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(sourceHeaders)) {
    const sourceHeaderRef = resolveSecretInputRef({
      value: headerValue,
      defaults: params.sourceSecretDefaults,
    }).ref;
    if (!sourceHeaderRef || !sourceHeaderRef.id.trim()) {
      continue;
    }
    markers[headerName] =
      sourceHeaderRef.source === "env"
        ? resolveEnvSecretRefHeaderValueMarker(sourceHeaderRef.id)
        : resolveNonEnvSecretRefHeaderValueMarker(sourceHeaderRef.source);
  }
  return markers;
}

export function enforceSourceManagedProviderSecrets(params: {
  providers: ModelsConfig["providers"];
  sourceProviders: ModelsConfig["providers"] | undefined;
  sourceSecretDefaults?: SecretDefaults;
  secretRefManagedProviders?: Set<string>;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const sourceProvidersByKey = normalizeSourceProviderLookup(params.sourceProviders);
  if (Object.keys(sourceProvidersByKey).length === 0) {
    return providers;
  }

  let nextProviders: Record<string, ProviderConfig> | null = null;
  for (const [providerKey, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    const sourceProvider = sourceProvidersByKey[providerKey.trim()];
    if (!sourceProvider) {
      continue;
    }
    let nextProvider = provider;
    let providerMutated = false;

    const sourceApiKeyMarker = resolveSourceManagedApiKeyMarker({
      sourceProvider,
      sourceSecretDefaults: params.sourceSecretDefaults,
    });
    if (sourceApiKeyMarker) {
      params.secretRefManagedProviders?.add(providerKey.trim());
      if (nextProvider.apiKey !== sourceApiKeyMarker) {
        providerMutated = true;
        nextProvider = {
          ...nextProvider,
          apiKey: sourceApiKeyMarker,
        };
      }
    }

    const sourceHeaderMarkers = resolveSourceManagedHeaderMarkers({
      sourceProvider,
      sourceSecretDefaults: params.sourceSecretDefaults,
    });
    if (Object.keys(sourceHeaderMarkers).length > 0) {
      const currentHeaders = isRecord(nextProvider.headers)
        ? (nextProvider.headers as Record<string, unknown>)
        : undefined;
      const nextHeaders = {
        ...(currentHeaders as Record<string, NonNullable<ProviderConfig["headers"]>[string]>),
      };
      let headersMutated = !currentHeaders;
      for (const [headerName, marker] of Object.entries(sourceHeaderMarkers)) {
        if (nextHeaders[headerName] === marker) {
          continue;
        }
        headersMutated = true;
        nextHeaders[headerName] = marker;
      }
      if (headersMutated) {
        providerMutated = true;
        nextProvider = {
          ...nextProvider,
          headers: nextHeaders,
        };
      }
    }

    if (!providerMutated) {
      continue;
    }
    if (!nextProviders) {
      nextProviders = { ...providers };
    }
    nextProviders[providerKey] = nextProvider;
  }

  return nextProviders ?? providers;
}

export function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  secretDefaults?: SecretDefaults;
  sourceProviders?: ModelsConfig["providers"];
  sourceSecretDefaults?: SecretDefaults;
  secretRefManagedProviders?: Set<string>;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const env = params.env ?? process.env;
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      mutated = true;
      continue;
    }
    if (normalizedKey !== key) {
      mutated = true;
    }
    let normalizedProvider = provider;
    const normalizedHeaders = normalizeHeaderValues({
      headers: normalizedProvider.headers,
      secretDefaults: params.secretDefaults,
    });
    if (normalizedHeaders.mutated) {
      mutated = true;
      normalizedProvider = { ...normalizedProvider, headers: normalizedHeaders.headers };
    }
    const profileApiKey = resolveApiKeyFromProfiles({
      provider: normalizedKey,
      store: authStore,
      env,
    });
    const providerWithConfiguredApiKey = normalizeConfiguredProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      secretDefaults: params.secretDefaults,
      profileApiKey,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });
    if (providerWithConfiguredApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithConfiguredApiKey;
    }

    // Reverse-lookup: if apiKey looks like a resolved secret value (not an env
    // var name), check whether it matches the canonical env var for this provider.
    // This prevents resolveConfigEnvVars()-resolved secrets from being persisted
    // to models.json as plaintext. (Fixes #38757)
    const providerWithResolvedEnvApiKey = normalizeResolvedEnvApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });
    if (providerWithResolvedEnvApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithResolvedEnvApiKey;
    }

    const providerWithApiKey = resolveMissingProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      profileApiKey,
      secretRefManagedProviders: params.secretRefManagedProviders,
      providerApiKeyResolver: PROVIDER_CONFIG_API_KEY_RESOLVERS[normalizedKey],
    });
    if (providerWithApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithApiKey;
    }

    const providerSpecificNormalized = normalizeProviderSpecificConfig(
      normalizedKey,
      normalizedProvider,
    );
    if (providerSpecificNormalized !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerSpecificNormalized;
    }

    const existing = next[normalizedKey];
    if (existing) {
      // Keep deterministic behavior if users accidentally define duplicate
      // provider keys that only differ by surrounding whitespace.
      mutated = true;
      next[normalizedKey] = {
        ...existing,
        ...normalizedProvider,
        models: normalizedProvider.models ?? existing.models,
      };
      continue;
    }
    next[normalizedKey] = normalizedProvider;
  }

  const normalizedProviders = mutated ? next : providers;
  return enforceSourceManagedProviderSecrets({
    providers: normalizedProviders,
    sourceProviders: params.sourceProviders,
    sourceSecretDefaults: params.sourceSecretDefaults,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}
