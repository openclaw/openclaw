/**
 * Plans root and plugin-owned model catalog writes. Setup and doctor flows use
 * this module to merge implicit provider discovery, explicit config, and
 * preserved secrets before touching models.json.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import {
  normalizeProviderConfigWithPlugin,
  resolveProviderConfigApiKeyWithPlugin,
} from "../plugins/provider-runtime.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { isRecord } from "../utils.js";
import { ensureAuthProfileStoreAsync } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  buildSourceModelFields,
  isWritableProviderConfig,
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  materializeConfiguredProviderCatalogModels,
  normalizeProviderCatalogModelsForConfig,
} from "./models-config.providers.catalog.js";
import { resolveImplicitProviders } from "./models-config.providers.implicit.js";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";
import type { SecretDefaults } from "./models-config.providers.secret-helpers.js";
import {
  normalizeConfiguredProviderApiKey,
  normalizeHeaderValues,
  normalizeResolvedEnvApiKey,
  resolveApiKeyFromProfiles,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secret-helpers.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
import {
  enforceSourceManagedProviderSecrets,
  normalizeSourceProviderLookup,
} from "./models-config.providers.source-managed.js";
import {
  encodePluginModelCatalogRelativePath,
  filterGeneratedPluginModelCatalogProviders,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  resolvePluginModelCatalogOwnerPluginId,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

async function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  secretDefaults?: SecretDefaults;
  sourceConfigForSecrets?: OpenClawConfig;
  secretRefManagedProviders?: Set<string>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): Promise<ModelsConfig["providers"]> {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const env = params.env ?? process.env;
  const sourceProviders = normalizeSourceProviderLookup(
    params.sourceConfigForSecrets?.models?.providers,
  );
  let authStore: Awaited<ReturnType<typeof ensureAuthProfileStoreAsync>> | undefined;
  const resolveProfileApiKey = async (providerKey: string) => {
    authStore ??= await ensureAuthProfileStoreAsync(params.agentDir, {
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
            path: `${appendConfigPathSegment("models.providers", sourceProvider.providerKey)}.apiKey`,
            value: sourceProvider.providerConfig.apiKey,
            defaults: params.sourceConfigForSecrets?.secrets?.defaults,
          }
        : undefined;
    normalizedProvider = normalizeConfiguredProviderApiKey({
      providerKey: normalizedKey,
      sourceInput,
      provider: normalizedProvider,
      secretDefaults: params.secretDefaults,
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

    const needsProfileApiKey = normalizedProvider.models?.length && !normalizedProvider.apiKey;
    const profileApiKey = needsProfileApiKey
      ? await resolveProfileApiKey(normalizedKey)
      : undefined;
    const runtimeProviderKey = needsProfileApiKey
      ? resolveProviderPluginLookupKey(normalizedKey).trim()
      : undefined;
    normalizedProvider = resolveMissingProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      profileApiKey,
      secretRefManagedProviders: params.secretRefManagedProviders,
      providerApiKeyResolver:
        runtimeProviderKey !== undefined
          ? (providerEnv) =>
              resolveProviderConfigApiKeyWithPlugin({
                provider: runtimeProviderKey,
                ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
                context: { provider: normalizedKey, env: providerEnv },
              })
          : undefined,
    });

    normalizedProvider =
      normalizeProviderConfigWithPlugin({
        provider: resolveProviderPluginLookupKey(normalizedKey, normalizedProvider),
        ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
        context: { provider: normalizedKey, providerConfig: normalizedProvider },
      }) ?? normalizedProvider;

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

export type PreparedModelsConfigContext = Readonly<{
  cfg: OpenClawConfig;
  discoveryAuthConfig: OpenClawConfig;
  discoveryAuthEnv?: NodeJS.ProcessEnv;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  envFingerprint: NodeJS.ProcessEnv | string;
  workspaceDir?: string;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
  onProviderCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
}>;

/**
 * Planned models.json result. When present, pluginCatalogWrites is the complete
 * replacement set; omission means the plan is non-authoritative for plugin catalogs.
 */
type ModelsJsonPlan =
  | {
      action: "skip" | "noop";
      pluginCatalogWrites?: Record<string, string>;
    }
  | {
      action: "write";
      contents: string;
      pluginCatalogWrites?: Record<string, string>;
    };

/** Resolves providers for models.json. */
async function resolveProvidersForModelsJson(params: {
  context: PreparedModelsConfigContext;
  authStore?: AuthProfileStore;
  discoveredProviderPluginIds: Map<string, string>;
}): Promise<Record<string, ProviderConfig>> {
  const { context } = params;
  const { agentDir, env } = context;
  const explicitProviders = stripBlankProviderBaseUrls(
    materializeConfiguredProviderCatalogModels(context.cfg.models?.providers, {
      manifestPlugins: context.pluginMetadataSnapshot,
    }) ?? {},
  );
  const cfg = context.cfg.models?.providers
    ? { ...context.cfg, models: { ...context.cfg.models, providers: explicitProviders } }
    : context.cfg;
  const sourceModelFields = buildSourceModelFields(explicitProviders);
  // When models.mode is "replace" the user opts out of provider discovery, so
  // skip the (potentially slow) implicit-provider resolver entirely and return
  // only the explicit providers. See openclaw#66957.
  if (cfg.models?.mode === "replace") {
    return mergeProviders({ implicit: {}, explicit: explicitProviders });
  }
  const implicitProviders = await resolveImplicitProviders({
    agentDir,
    ...(params.authStore ? { authStore: params.authStore } : {}),
    config: cfg,
    discoveryAuthConfig: context.discoveryAuthConfig,
    discoveryAuthEnv: context.discoveryAuthEnv,
    sourceConfigForSecrets: context.sourceConfigForSecrets,
    env,
    ...(context.workspaceDir ? { workspaceDir: context.workspaceDir } : {}),
    explicitProviders,
    sourceModelFields,
    pluginMetadataSnapshot: context.pluginMetadataSnapshot,
    preparedStaticProviderCatalog: context.preparedStaticProviderCatalog,
    providerDiscoveryProviderIds: context.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: context.providerDiscoveryTimeoutMs,
    providerDiscoveryEntriesOnly: context.providerDiscoveryEntriesOnly === true,
    onProviderCatalogOutcome: context.onProviderCatalogOutcome,
    discoveredProviderPluginIds: params.discoveredProviderPluginIds,
  });
  return mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
    sourceModelFields,
  });
}

function stripBlankProviderBaseUrls(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    if (typeof provider?.baseUrl === "string" && provider.baseUrl.trim() === "") {
      const { baseUrl: _blank, ...rest } = provider;
      next[key] = rest as ProviderConfig;
      mutated = true;
      continue;
    }
    next[key] = provider;
  }
  return mutated ? next : providers;
}

function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig> {
  if (params.mode !== "merge") {
    return params.providers;
  }
  const existing = params.existingParsed;
  if (!isRecord(existing) || !isRecord(existing.providers)) {
    return params.providers;
  }
  return mergeWithExistingProviderSecrets({
    nextProviders: params.providers,
    existingProviders: existing.providers as Record<string, ExistingProviderConfig>,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}

function filterWritableProviders(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const next = Object.fromEntries(
    Object.entries(providers).filter(([, provider]) => isWritableProviderConfig(provider)),
  );
  return Object.keys(next).length === Object.keys(providers).length ? providers : next;
}

/** Plans root and plugin-owned model catalog writes for the current runtime. */
export async function planOpenClawModelsJson(params: {
  context: PreparedModelsConfigContext;
  authStore?: AuthProfileStore;
  existingRaw: string;
  existingParsed: unknown;
  pluginCatalogs?: readonly PersistedPluginModelCatalog[];
}): Promise<ModelsJsonPlan> {
  const { context } = params;
  const { cfg, agentDir, env } = context;
  const discoveredProviderPluginIds = new Map<string, string>();
  const providers = await resolveProvidersForModelsJson({
    context,
    ...(params.authStore ? { authStore: params.authStore } : {}),
    discoveredProviderPluginIds,
  });

  if (Object.keys(providers).length === 0) {
    if (cfg.models?.mode === "replace") {
      return {
        action: "write",
        contents: `${JSON.stringify({ providers: {} }, null, 2)}\n`,
        pluginCatalogWrites: {},
      };
    }
    return { action: "skip" };
  }

  const mode = cfg.models?.mode ?? "merge";
  const secretRefManagedProviders = new Set<string>();
  const providerPolicyManifestRegistry =
    context.pluginMetadataSnapshot?.pluginIds === undefined
      ? context.pluginMetadataSnapshot?.manifestRegistry
      : undefined;
  const normalize = () =>
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceConfigForSecrets: context.sourceConfigForSecrets,
      secretRefManagedProviders,
      ...(providerPolicyManifestRegistry
        ? { manifestRegistry: providerPolicyManifestRegistry }
        : {}),
    });
  // Configless auth-marker readers share the captured process metadata as well as policy hooks.
  // A scoped inventory cannot supply their complete provider namespace.
  const normalizedProviders =
    (await (context.pluginMetadataSnapshot && providerPolicyManifestRegistry
      ? withPluginMetadataSnapshotScope(context.pluginMetadataSnapshot, normalize)
      : normalize())) ?? providers;
  /** Recovers only generated providers; manual root declarations never enter this source. */
  const existingPluginCatalogs = params.pluginCatalogs ?? [];
  const generatedCatalogProviders: Record<string, unknown> = {};
  for (const { pluginId, contents } of existingPluginCatalogs) {
    const catalog = safeParseJsonRecord(contents);
    if (!catalog || !isRecord(catalog.providers)) {
      continue;
    }
    Object.assign(
      generatedCatalogProviders,
      filterGeneratedPluginModelCatalogProviders({
        catalogPluginId: pluginId,
        config: context.cfg,
        parsedCatalog: catalog,
        pluginMetadataSnapshot: context.pluginMetadataSnapshot,
        providers: catalog.providers,
      }),
    );
  }
  const mergedProviders = resolveProvidersForMode({
    mode,
    existingParsed: { providers: generatedCatalogProviders },
    providers: normalizedProviders,
    secretRefManagedProviders,
  });
  const finalizeProviders = (candidateProviders: Record<string, ProviderConfig>) => {
    const normalized =
      normalizeProviderCatalogModelsForConfig(candidateProviders) ?? candidateProviders;
    return filterWritableProviders(
      enforceSourceManagedProviderSecrets({
        providers: normalized,
        sourceConfigForSecrets: context.sourceConfigForSecrets,
        secretRefManagedProviders,
      }) ?? normalized,
    );
  };
  const explicitProviderIds = new Set(
    Object.keys(cfg.models?.providers ?? {}).map((providerId) => normalizeProviderId(providerId)),
  );
  const providersByOwner = finalizeProviders(mergedProviders);
  const partitionMetadataSnapshot = context.pluginMetadataSnapshot;
  const splitRootProviders: Record<string, ProviderConfig> = {};
  const pluginProviders: Record<string, Record<string, ProviderConfig>> = {};
  for (const [providerId, provider] of Object.entries(providersByOwner)) {
    const normalizedId = normalizeProviderId(providerId);
    // Discovery output belongs to the plugin that produced it even when the owner lookup fails
    // (a scoped snapshot, or a hook alias no manifest claims); only config reaches the root file.
    const pluginId =
      resolvePluginModelCatalogOwnerPluginId({
        providerId,
        pluginMetadataSnapshot: partitionMetadataSnapshot,
      }) ??
      (explicitProviderIds.has(normalizedId)
        ? undefined
        : discoveredProviderPluginIds.get(normalizedId));
    if (!pluginId) {
      splitRootProviders[providerId] = provider;
      continue;
    }
    const pluginCatalog = (pluginProviders[pluginId] ??= {});
    pluginCatalog[providerId] = provider;
  }
  const pluginCatalogWrites = Object.fromEntries(
    Object.entries(pluginProviders).map(([pluginId, catalogProviders]) => [
      encodePluginModelCatalogRelativePath(pluginId),
      `${JSON.stringify({ generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers: catalogProviders }, null, 2)}\n`,
    ]),
  );
  // Root models.json is author-owned even when a plugin also owns that provider id.
  const rootProviders = resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
    providers: splitRootProviders,
    secretRefManagedProviders,
  });
  const nextContents = `${JSON.stringify(
    {
      providers: finalizeProviders(rootProviders),
    },
    null,
    2,
  )}\n`;

  if (params.existingRaw === nextContents && Object.keys(pluginCatalogWrites).length === 0) {
    return { action: "noop", pluginCatalogWrites };
  }

  return {
    action: "write",
    contents: nextContents,
    pluginCatalogWrites,
  };
}
