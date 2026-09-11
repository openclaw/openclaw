/**
 * Plans root and plugin-owned model catalog writes. Setup and doctor flows use
 * this module to merge implicit provider discovery, explicit config, and
 * preserved secrets before touching models.json.
 */
import { copyConfigResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import { isRecord } from "../utils.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  buildSourceModelFields,
  mergeProviders,
  mergeWithExistingProviderSecrets,
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
  requestedProviderIds?: readonly string[];
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
  copyConfigResolutionFacts(context.cfg, cfg);
  const sourceModelFields = buildSourceModelFields(explicitProviders);
  // When models.mode is "replace" the user opts out of provider discovery, so
  // skip the (potentially slow) implicit-provider resolver entirely and return
  // only the explicit providers. See openclaw#66957.
  if (cfg.models?.mode === "replace") {
    return mergeProviders({ implicit: {}, explicit: explicitProviders });
  }
  const implicitProviders = await resolveImplicitProviders({
    agentDir,
    requestedProviderIds: context.requestedProviderIds,
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
      providers: collectGeneratedCatalogProviders({
        catalogs: params.pluginCatalogs ?? [],
        context,
      }),
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
  const finalProviders = filterWritableProviders(secretEnforcedProviders);
  const splitProviders = splitProvidersByPluginOwner({
    providers: finalProviders,
    pluginMetadataSnapshot: context.pluginMetadataSnapshot,
  });
  const pluginCatalogWrites = buildPluginCatalogWrites(splitProviders.pluginProviders);
  // Root models.json is author-owned even when a plugin also owns that provider id.
  const rootProviders = resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
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
  const nextContents = `${JSON.stringify(
    {
      providers: filterWritableProviders(rootWithManagedSecrets),
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
