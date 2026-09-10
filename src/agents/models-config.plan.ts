/**
 * Plans root and plugin-owned model catalog writes. Setup and doctor flows use
 * this module to merge implicit provider discovery, explicit config, and
 * preserved secrets before touching models.json.
 */
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import { isRecord } from "../utils.js";
import {
  getRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreForSecretsRuntime,
} from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import {
  formatModelCatalogProfileReference,
  parseModelCatalogProfileReference,
  rewriteModelCatalogCredentialReferences,
  type ModelCatalogCredentialReference,
} from "./model-catalog-json.js";
import {
  buildSourceModelFields,
  mergeProviders,
  mergeWithExistingProviderSecrets,
  normalizeProviderMapKeys,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  enforceSourceManagedProviderSecrets,
  materializeConfiguredProviderCatalogModels,
  normalizeProviderCatalogModelsForConfig,
  normalizeProviders,
  resolveImplicitProviders,
  type ProviderConfig,
} from "./models-config.providers.js";
import {
  encodePluginModelCatalogRelativePath,
  filterGeneratedPluginModelCatalogProviders,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  resolvePluginModelCatalogOwnerPluginId,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "./provider-auth-aliases.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

export type PreparedModelsConfigContext = Readonly<{
  cfg: OpenClawConfig;
  discoveryAuthConfig: OpenClawConfig;
  discoveryAuthEnv?: NodeJS.ProcessEnv;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  envFingerprint: NodeJS.ProcessEnv | string;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<
    PluginMetadataSnapshot,
    "index" | "manifestRegistry" | "owners" | "pluginIds"
  >;
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
      action: "skip";
      pluginCatalogWrites?: Record<string, string>;
    }
  | {
      action: "noop";
      pluginCatalogWrites?: Record<string, string>;
    }
  | {
      action: "write";
      contents: string;
      pluginCatalogWrites?: Record<string, string>;
    };

function splitProvidersByPluginOwner(params: {
  providers: Record<string, ProviderConfig>;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
}): {
  rootProviders: Record<string, ProviderConfig>;
  pluginProviders: Record<string, Record<string, ProviderConfig>>;
} {
  const rootProviders: Record<string, ProviderConfig> = {};
  const pluginProviders: Record<string, Record<string, ProviderConfig>> = {};
  for (const [providerId, provider] of Object.entries(params.providers)) {
    const pluginId = resolvePluginModelCatalogOwnerPluginId({
      providerId,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    });
    if (!pluginId) {
      rootProviders[providerId] = provider;
      continue;
    }
    const pluginCatalog = (pluginProviders[pluginId] ??= {});
    pluginCatalog[providerId] = provider;
  }
  return { rootProviders, pluginProviders };
}

function buildPluginCatalogWrites(
  pluginProviders: Record<string, Record<string, ProviderConfig>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pluginProviders).map(([pluginId, providers]) => [
      encodePluginModelCatalogRelativePath(pluginId),
      `${JSON.stringify({ generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers }, null, 2)}\n`,
    ]),
  );
}

/** Resolves providers for models.json. */
async function resolveProvidersForModelsJson(params: {
  context: PreparedModelsConfigContext;
  authStore?: AuthProfileStore;
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
    ...(context.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: context.pluginMetadataSnapshot }
      : {}),
    ...(context.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: context.preparedStaticProviderCatalog }
      : {}),
    ...(context.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: context.providerDiscoveryProviderIds }
      : {}),
    ...(context.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: context.providerDiscoveryTimeoutMs }
      : {}),
    ...(context.providerDiscoveryEntriesOnly === true
      ? { providerDiscoveryEntriesOnly: true }
      : {}),
    ...(context.onProviderCatalogOutcome
      ? { onProviderCatalogOutcome: context.onProviderCatalogOutcome }
      : {}),
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
  const existingProviders = existing.providers as Record<
    string,
    NonNullable<ModelsConfig["providers"]>[string]
  >;
  return mergeWithExistingProviderSecrets({
    nextProviders: params.providers,
    existingProviders: existingProviders as Record<string, ExistingProviderConfig>,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}

function isWritableProviderConfig(provider: ProviderConfig): boolean {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return true;
  }
  // AuthStorage can supply omitted keys; an explicitly empty key still violates the schema.
  return Boolean(provider.baseUrl?.trim() && (provider.apiKey === undefined || provider.apiKey));
}

function filterWritableProviders(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const next = Object.fromEntries(
    Object.entries(providers).filter(([, provider]) => isWritableProviderConfig(provider)),
  );
  return Object.keys(next).length === Object.keys(providers).length ? providers : next;
}

function catalogCredentialProviderMatches(
  provider: string,
  credentialProvider: string,
  lookup: ProviderAuthAliasLookupParams,
): boolean {
  // The common exact-realm case does not require plugin discovery. Aliased
  // realms use the captured planning scope, never another request's registry.
  return (
    normalizeProviderId(provider) === normalizeProviderId(credentialProvider) ||
    resolveProviderIdForAuth(provider, lookup) ===
      resolveProviderIdForAuth(credentialProvider, { ...lookup, storedCredential: true })
  );
}

function resolveCatalogProfileId(params: {
  apiKey: string;
  provider: string;
  store: AuthProfileStore;
  authAliasLookup: ProviderAuthAliasLookupParams;
}): string | undefined {
  const exactId = parseModelCatalogProfileReference(params.apiKey);
  const profileId = exactId ?? params.apiKey;
  const namedCredential = Object.hasOwn(params.store.profiles, profileId)
    ? params.store.profiles[profileId]
    : undefined;
  if (namedCredential) {
    if (
      catalogCredentialProviderMatches(
        params.provider,
        namedCredential.provider,
        params.authAliasLookup,
      ) &&
      (namedCredential.type === "api_key" || namedCredential.type === "token")
    ) {
      return profileId;
    }
    throw new Error(
      `Provider "${params.provider}" has an incompatible catalog credential reference. Run openclaw doctor --fix before starting OpenClaw.`,
    );
  }
  if (exactId !== undefined) {
    throw new Error(`Provider "${params.provider}" references a missing canonical auth profile.`);
  }
  return Object.entries(params.store.profiles).find(
    ([, credential]) =>
      catalogCredentialProviderMatches(
        params.provider,
        credential.provider,
        params.authAliasLookup,
      ) &&
      ((credential.type === "api_key" && credential.key === params.apiKey) ||
        (credential.type === "token" && credential.token === params.apiKey)),
  )?.[0];
}

function canonicalizeGeneratedProviderApiKeys(params: {
  agentDir: string;
  authStore?: AuthProfileStore;
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
  discoveredProviders: Record<string, ProviderConfig>;
  generatedProviderIds?: ReadonlySet<string>;
  authAliasLookup: ProviderAuthAliasLookupParams;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig> {
  const configuredProviders = normalizeProviderMapKeys(
    params.sourceConfigForSecrets.models?.providers,
  );
  let store = params.authStore;
  let mutated = false;
  const providers = Object.fromEntries(
    Object.entries(params.providers).map(([providerId, provider]) => {
      const apiKey = typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";
      const authAliasLookup = { ...params.authAliasLookup, baseUrl: provider.baseUrl };
      if (
        (params.generatedProviderIds && !params.generatedProviderIds.has(providerId)) ||
        !apiKey ||
        isNonSecretApiKeyMarker(apiKey) ||
        params.secretRefManagedProviders.has(providerId)
      ) {
        return [providerId, provider];
      }
      // Explicit config remains a canonical credential owner. Its generated
      // projection contains metadata only; request-time auth reads the config.
      const configuredKey = configuredProviders[providerId]?.apiKey;
      if (typeof configuredKey === "string" && configuredKey.trim() === apiKey) {
        const { apiKey: _configuredKey, ...metadata } = provider;
        mutated = true;
        return [providerId, metadata];
      }
      store ??=
        getRuntimeAuthProfileStoreSnapshot(params.agentDir) ??
        loadAuthProfileStoreForSecretsRuntime(params.agentDir, { config: params.config });
      const profileId = resolveCatalogProfileId({
        apiKey,
        provider: providerId,
        store,
        authAliasLookup,
      });
      // Discovery providers return env-var names as opaque all-caps markers. Keep
      // those markers even when the referenced variable is intentionally absent
      // from this process; the generated catalog must not materialize the value.
      if (!profileId && /^[A-Z_][A-Z0-9_]*$/.test(apiKey)) {
        return [providerId, provider];
      }
      if (!profileId) {
        // A discovery hook may use a transient credential from an independent
        // source. Retain its inventory, but never turn that material into an
        // authentication authority. Retained copies and exact references need
        // verified migration instead of silently selecting different auth.
        const discoveredKey = params.discoveredProviders[providerId]?.apiKey;
        const isKnownProfileId = Object.hasOwn(store.profiles, apiKey);
        const matchesIndependentCredential = Object.values(store.profiles).some(
          (credential) =>
            !catalogCredentialProviderMatches(providerId, credential.provider, authAliasLookup) &&
            ((credential.type === "api_key" && credential.key === apiKey) ||
              (credential.type === "token" && credential.token === apiKey)),
        );
        if (
          !isKnownProfileId &&
          matchesIndependentCredential &&
          discoveredKey === provider.apiKey
        ) {
          const { apiKey: _discoveryKey, ...metadata } = provider;
          mutated = true;
          return [providerId, metadata];
        }
        throw new Error(
          `Provider "${providerId}" has a plaintext catalog credential that is not in the credential store. Run openclaw doctor --fix before starting OpenClaw.`,
        );
      }
      const reference = formatModelCatalogProfileReference(profileId);
      if (provider.apiKey === reference) {
        return [providerId, provider];
      }
      mutated = true;
      return [providerId, { ...provider, apiKey: reference }];
    }),
  );
  return mutated ? providers : params.providers;
}

/** Recovers only generated providers; manual root declarations never enter this source. */
function collectGeneratedCatalogProviders(params: {
  catalogs: readonly PersistedPluginModelCatalog[];
  context: PreparedModelsConfigContext;
}): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const { pluginId, contents } of params.catalogs) {
    let catalog: unknown;
    try {
      catalog = JSON.parse(contents) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(catalog) || !isRecord(catalog.providers)) {
      continue;
    }
    Object.assign(
      providers,
      filterGeneratedPluginModelCatalogProviders({
        catalogPluginId: pluginId,
        config: params.context.cfg,
        parsedCatalog: catalog,
        pluginMetadataSnapshot: params.context.pluginMetadataSnapshot,
        providers: catalog.providers,
      }),
    );
  }
  return providers;
}

/** Retire root literals only after their canonical credential has been verified/imported. */
function rewriteVerifiedRootCredentials(params: {
  existingRaw: string;
  existingParsed: unknown;
  agentDir: string;
  authStore?: AuthProfileStore;
  config: OpenClawConfig;
  authAliasLookup: ProviderAuthAliasLookupParams;
}): { parsed: Record<string, unknown>; contents: string } | undefined {
  const root = params.existingParsed;
  if (!isRecord(root) || !isRecord(root.providers)) {
    return undefined;
  }
  let store = params.authStore;
  const references: ModelCatalogCredentialReference[] = [];
  const providers = { ...root.providers };
  for (const [providerId, entry] of Object.entries(providers)) {
    if (
      !isRecord(entry) ||
      typeof entry.apiKey !== "string" ||
      !entry.apiKey.trim() ||
      parseModelCatalogProfileReference(entry.apiKey) !== undefined ||
      isNonSecretApiKeyMarker(entry.apiKey)
    ) {
      continue;
    }
    store ??=
      getRuntimeAuthProfileStoreSnapshot(params.agentDir) ??
      loadAuthProfileStoreForSecretsRuntime(params.agentDir, { config: params.config });
    const apiKey = entry.apiKey.trim();
    const authAliasLookup = {
      ...params.authAliasLookup,
      baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : undefined,
    };
    const named = Object.hasOwn(store.profiles, apiKey) ? store.profiles[apiKey] : undefined;
    // Unknown/manual declarations are not imports. Unusable named references
    // remain intact so the request boundary can report their exact failure.
    if (
      named &&
      (!catalogCredentialProviderMatches(providerId, named.provider, authAliasLookup) ||
        (named.type !== "api_key" && named.type !== "token"))
    ) {
      continue;
    }
    const profileId = resolveCatalogProfileId({
      apiKey,
      provider: providerId,
      store,
      authAliasLookup,
    });
    if (!profileId) {
      continue;
    }
    providers[providerId] = { ...entry, apiKey: formatModelCatalogProfileReference(profileId) };
    references.push({ provider: providerId, key: entry.apiKey, profileId });
  }
  if (references.length === 0) {
    return undefined;
  }
  const parsed = { ...root, providers };
  return {
    parsed,
    // Parsed-only plans have no authored source text to preserve.
    contents: params.existingRaw
      ? rewriteModelCatalogCredentialReferences(params.existingRaw, references)
      : `${JSON.stringify(parsed, null, 2)}\n`,
  };
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
  const providers = await resolveProvidersForModelsJson({
    context,
    ...(params.authStore ? { authStore: params.authStore } : {}),
  });

  const authAliasLookup: ProviderAuthAliasLookupParams = {
    config: cfg,
    env,
    workspaceDir: context.workspaceDir,
    ...(context.pluginMetadataSnapshot
      ? {
          metadataSnapshot: {
            plugins: context.pluginMetadataSnapshot.manifestRegistry.plugins,
            owners: context.pluginMetadataSnapshot.owners,
          },
        }
      : {}),
  };
  const rewrittenRoot =
    cfg.models?.mode === "replace"
      ? undefined
      : rewriteVerifiedRootCredentials({
          existingRaw: params.existingRaw,
          existingParsed: params.existingParsed,
          agentDir,
          ...(params.authStore ? { authStore: params.authStore } : {}),
          config: cfg,
          authAliasLookup,
        });
  const retainedGeneratedProviders = collectGeneratedCatalogProviders({
    catalogs: params.pluginCatalogs ?? [],
    context,
  });
  if (Object.keys(providers).length === 0) {
    if (cfg.models?.mode === "replace") {
      return {
        action: "write",
        contents: `${JSON.stringify({ providers: {} }, null, 2)}\n`,
        pluginCatalogWrites: {},
      };
    }
    // An empty discovery result does not exempt retained generated catalogs
    // from the same credential-free publication boundary.
    if (Object.keys(retainedGeneratedProviders).length === 0) {
      return rewrittenRoot
        ? {
            action: "write",
            contents: rewrittenRoot.contents,
          }
        : { action: "skip" };
    }
  }

  const mode = cfg.models?.mode ?? "merge";
  const secretRefManagedProviders = new Set<string>();
  const providerPolicyManifestRegistry =
    context.pluginMetadataSnapshot?.pluginIds === undefined
      ? context.pluginMetadataSnapshot?.manifestRegistry
      : undefined;
  const normalizedProviders =
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
    }) ?? providers;
  const mergedProviders = resolveProvidersForMode({
    mode,
    existingParsed: {
      providers: retainedGeneratedProviders,
    },
    providers: normalizedProviders,
    secretRefManagedProviders,
  });
  const normalizedMergedProviders =
    normalizeProviderCatalogModelsForConfig(mergedProviders) ?? mergedProviders;
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: normalizedMergedProviders,
      sourceConfigForSecrets: context.sourceConfigForSecrets,
      secretRefManagedProviders,
    }) ?? normalizedMergedProviders;
  const finalProviders = canonicalizeGeneratedProviderApiKeys({
    agentDir,
    ...(params.authStore ? { authStore: params.authStore } : {}),
    config: cfg,
    sourceConfigForSecrets: context.sourceConfigForSecrets,
    discoveredProviders: normalizedProviders,
    authAliasLookup,
    providers: filterWritableProviders(secretEnforcedProviders),
    secretRefManagedProviders,
  });
  const splitProviders = splitProvidersByPluginOwner({
    providers: finalProviders,
    pluginMetadataSnapshot: context.pluginMetadataSnapshot,
  });
  const pluginCatalogWrites = buildPluginCatalogWrites(splitProviders.pluginProviders);
  // Root models.json is author-owned even when a plugin also owns that provider id.
  const rootProviders = resolveProvidersForMode({
    mode,
    existingParsed: rewrittenRoot?.parsed ?? params.existingParsed,
    providers: splitProviders.rootProviders,
    secretRefManagedProviders,
  });
  const normalizedRootProviders =
    normalizeProviderCatalogModelsForConfig(rootProviders) ?? rootProviders;
  const rootWithManagedSecrets =
    enforceSourceManagedProviderSecrets({
      providers: normalizedRootProviders,
      sourceConfigForSecrets: context.sourceConfigForSecrets,
      secretRefManagedProviders,
    }) ?? normalizedRootProviders;
  const canonicalRootProviders = canonicalizeGeneratedProviderApiKeys({
    agentDir,
    ...(params.authStore ? { authStore: params.authStore } : {}),
    config: cfg,
    sourceConfigForSecrets: context.sourceConfigForSecrets,
    discoveredProviders: normalizedProviders,
    // Root-only declarations remain author-owned. Only the current generated
    // root projection is canonicalized after the last preservation merge.
    generatedProviderIds: new Set(
      Object.keys(splitProviders.rootProviders).filter(
        (providerId) =>
          rootWithManagedSecrets[providerId]?.apiKey !==
          splitProviders.rootProviders[providerId]?.apiKey,
      ),
    ),
    authAliasLookup,
    providers: filterWritableProviders(rootWithManagedSecrets),
    secretRefManagedProviders,
  });
  const nextRoot = {
    ...(mode === "merge" && isRecord(params.existingParsed) ? params.existingParsed : {}),
    providers: canonicalRootProviders,
  };
  // Preserve authored JSONC bytes when only verified credential references change.
  const nextContents =
    mode === "merge" && isDeepStrictEqual(nextRoot, rewrittenRoot?.parsed ?? params.existingParsed)
      ? (rewrittenRoot?.contents ?? params.existingRaw)
      : `${JSON.stringify(nextRoot, null, 2)}\n`;

  if (params.existingRaw === nextContents && Object.keys(pluginCatalogWrites).length === 0) {
    return { action: "noop", pluginCatalogWrites };
  }

  return {
    action: "write",
    contents: nextContents,
    pluginCatalogWrites,
  };
}
