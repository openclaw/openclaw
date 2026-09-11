/** Normalizes provider settings and resolves current credential sources. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import {
  normalizeProviderSpecificConfig,
  resolveProviderConfigApiKeyResolver,
} from "./models-config.providers.policy.js";
import type { ProviderConfig, SecretDefaults } from "./models-config.providers.secret-helpers.js";
import {
  normalizeConfiguredProviderApiKey,
  normalizeHeaderValues,
  normalizeResolvedEnvApiKey,
  resolveApiKeyFromProfiles,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secret-helpers.js";
import {
  enforceSourceManagedProviderSecrets,
  normalizeSourceProviderLookup,
} from "./models-config.providers.source-managed.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  secretDefaults?: SecretDefaults;
  sourceConfigForSecrets?: OpenClawConfig;
  secretRefManagedProviders?: Set<string>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const env = params.env ?? process.env;
  const sourceProviders = normalizeSourceProviderLookup(
    params.sourceConfigForSecrets?.models?.providers,
  );
  let authStore: ReturnType<typeof ensureAuthProfileStore> | undefined;
  const resolveProfileApiKey = (providerKey: string) => {
    authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    return resolveApiKeyFromProfiles({
      provider: providerKey,
      store: authStore,
      env,
    });
  };
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
    // Only authored fields inherit loader facts; plugin-discovered inputs keep their own syntax.
    const sourceProvider = sourceProviders.get(normalizeProviderId(normalizedKey));
    const source =
      sourceProvider && params.sourceConfigForSecrets
        ? {
            config: params.sourceConfigForSecrets,
            providerKey: sourceProvider.providerKey,
          }
        : undefined;
    let normalizedProvider = provider;
    const normalizedHeaders = normalizeHeaderValues({
      headers: normalizedProvider.headers,
      secretDefaults: params.secretDefaults,
      source,
    });
    if (normalizedHeaders.mutated) {
      normalizedProvider = { ...normalizedProvider, headers: normalizedHeaders.headers };
    }
    const sourceInput =
      sourceProvider?.providerConfig.apiKey !== undefined
        ? {
            config: params.sourceConfigForSecrets,
            path: `models.providers.${sourceProvider.providerKey}.apiKey`,
            value: sourceProvider.providerConfig.apiKey,
            defaults: params.sourceConfigForSecrets?.secrets?.defaults,
          }
        : undefined;
    normalizedProvider = normalizeConfiguredProviderApiKey({
      providerKey: normalizedKey,
      sourceInput,
      provider: normalizedProvider,
      secretDefaults: params.secretDefaults,
      profileApiKey: undefined,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });

    // Reverse-lookup: if apiKey looks like a resolved secret value (not an env
    // var name), check whether it matches the canonical env var for this provider.
    // This prevents resolveConfigEnvVars()-resolved secrets from being persisted
    // to models.json as plaintext. (Fixes #38757)
    normalizedProvider = normalizeResolvedEnvApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });

    const needsProfileApiKey =
      Array.isArray(normalizedProvider.models) &&
      normalizedProvider.models.length > 0 &&
      !(
        (typeof normalizedProvider.apiKey === "string" && normalizedProvider.apiKey.trim()) ||
        normalizedProvider.apiKey
      );
    const profileApiKey = needsProfileApiKey ? resolveProfileApiKey(normalizedKey) : undefined;
    const providerApiKeyResolver = needsProfileApiKey
      ? resolveProviderConfigApiKeyResolver(normalizedKey, undefined, params.manifestRegistry)
      : undefined;
    normalizedProvider = resolveMissingProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      profileApiKey,
      secretRefManagedProviders: params.secretRefManagedProviders,
      providerApiKeyResolver,
    });

    normalizedProvider = normalizeProviderSpecificConfig(
      normalizedKey,
      normalizedProvider,
      params.manifestRegistry,
    );

    mutated ||= normalizedProvider !== provider;

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
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}
