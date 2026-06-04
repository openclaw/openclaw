/**
 * Plans root and plugin-owned model catalog writes. Setup and doctor flows use
 * this module to merge implicit provider discovery, explicit config, and
 * preserved secrets before touching models.json.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isRecord } from "../utils.js";
import { isLocalApiKeyMarker, isUsableLocalAuthMarker } from "./model-auth-local.js";
import {
  NON_ENV_SECRETREF_MARKER,
  isOAuthApiKeyMarker,
  resolveOAuthApiKeyMarker,
} from "./model-auth-markers.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  applyNativeStreamingUsageCompat,
  enforceSourceManagedProviderSecrets,
  normalizeProviderCatalogModelsForConfig,
  normalizeProviders,
  resolveImplicitProviders,
  type ProviderConfig,
} from "./models-config.providers.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

/** Dependency hook for resolving implicit model providers while planning models.json. */
export type ResolveImplicitProvidersForModelsJson = (params: {
  agentDir: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders: Record<string, ProviderConfig>;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
}) => Promise<Record<string, ProviderConfig>>;

/** Planned models.json write/noop/skip result plus plugin catalog sidecar writes. */
export type ModelsJsonPlan =
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

/** Resolves providers for models.json with injectable implicit-provider discovery. */
export async function resolveProvidersForModelsJsonWithDeps(
  params: {
    cfg: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<Record<string, ProviderConfig>> {
  const { cfg, agentDir, env } = params;
  const explicitProviders = cfg.models?.providers ?? {};
  const resolveImplicitProvidersImpl = deps?.resolveImplicitProviders ?? resolveImplicitProviders;
  const implicitProviders = await resolveImplicitProvidersImpl({
    agentDir,
    config: cfg,
    env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    explicitProviders,
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
    ...(params.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: params.providerDiscoveryProviderIds }
      : {}),
    ...(params.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs }
      : {}),
    ...(params.providerDiscoveryEntriesOnly === true ? { providerDiscoveryEntriesOnly: true } : {}),
  });
  return mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
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

function isWritableProviderConfig(providerKey: string, provider: ProviderConfig): boolean {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return true;
  }
  return (
    Boolean(provider.baseUrl?.trim()) &&
    (hasWritableProviderApiKey(providerKey, provider) ||
      (isProviderApiKeyAbsent(provider.apiKey) &&
        isMissingApiKeyProviderAuthAllowed(provider.auth)))
  );
}

function hasWritableProviderApiKey(providerKey: string, provider: ProviderConfig): boolean {
  if (typeof provider.apiKey !== "string") {
    return Boolean(provider.apiKey);
  }
  const apiKey = provider.apiKey.trim();
  if (!apiKey || isUnusableWritableApiKeyMarker(apiKey)) {
    return false;
  }
  if (isOAuthApiKeyMarker(apiKey)) {
    return apiKey === resolveOAuthApiKeyMarker(providerKey);
  }
  if (!isLocalApiKeyMarker(apiKey)) {
    return true;
  }
  return isUsableLocalAuthMarker({
    api: provider.api,
    apiKey,
    baseUrl: provider.baseUrl,
  });
}

function isUnusableWritableApiKeyMarker(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  return trimmed === NON_ENV_SECRETREF_MARKER;
}

function isMissingApiKeyProviderAuthAllowed(auth: ProviderConfig["auth"]): boolean {
  return auth === "aws-sdk" || auth === "oauth";
}

function isProviderApiKeyAbsent(apiKey: ProviderConfig["apiKey"]): boolean {
  if (apiKey === undefined || apiKey === null) {
    return true;
  }
  return typeof apiKey === "string" && !apiKey.trim();
}

function filterWritableProviders(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const next = Object.fromEntries(
    Object.entries(providers).filter(([providerKey, provider]) =>
      isWritableProviderConfig(providerKey, provider),
    ),
  );
  return Object.keys(next).length === Object.keys(providers).length ? providers : next;
}

function stripBlankProviderApiKeys(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let changed = false;
  const next: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    if (typeof provider.apiKey === "string" && !provider.apiKey.trim()) {
      const sanitized = { ...provider };
      delete sanitized.apiKey;
      next[key] = sanitized;
      changed = true;
      continue;
    }
    next[key] = provider;
  }
  return changed ? next : providers;
}

/** Plans root and plugin-owned model catalog writes with injectable provider discovery. */
export async function planOpenClawModelsJsonWithDeps(
  params: {
    cfg: OpenClawConfig;
    sourceConfigForSecrets?: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    existingRaw: string;
    existingParsed: unknown;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<ModelsJsonPlan> {
  const { cfg, agentDir, env } = params;
  const providers = await resolveProvidersForModelsJsonWithDeps(
    {
      cfg,
      agentDir,
      env,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
        : {}),
      ...(params.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: params.providerDiscoveryProviderIds }
        : {}),
      ...(params.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs }
        : {}),
      ...(params.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
        : {}),
    },
    deps,
  );

  if (Object.keys(providers).length === 0) {
    if (params.cfg.models?.mode === "replace") {
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
  const manifestPlugins = params.pluginMetadataSnapshot?.manifestRegistry.plugins;
  const normalizedProviders =
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
      manifestPlugins,
    }) ?? providers;
  const mergedProviders = resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
    providers: normalizedProviders,
    secretRefManagedProviders,
  });
  const normalizedMergedProviders =
    normalizeProviderCatalogModelsForConfig(mergedProviders, {
      manifestPlugins,
    }) ?? mergedProviders;
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: normalizedMergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? normalizedMergedProviders;
  const writableProviders = stripBlankProviderApiKeys(
    filterWritableProviders(secretEnforcedProviders),
  );
  const finalProviders = applyNativeStreamingUsageCompat(writableProviders);
  const splitProviders = splitProvidersByPluginOwner({
    providers: finalProviders,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
  });
  const pluginCatalogWrites = buildPluginCatalogWrites(splitProviders.pluginProviders);
  const nextContents = `${JSON.stringify(
    {
      providers: splitProviders.rootProviders,
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

/** Plans root and plugin-owned model catalog writes for the current runtime. */
export async function planOpenClawModelsJson(
  params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0],
): Promise<ModelsJsonPlan> {
  return planOpenClawModelsJsonWithDeps(params);
}
