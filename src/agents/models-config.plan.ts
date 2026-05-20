import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isRecord } from "../utils.js";
import { isNonSecretApiKeyMarker, NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
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

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
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

export type ModelsJsonPlan =
  | {
      action: "skip";
    }
  | {
      action: "noop";
    }
  | {
      action: "write";
      contents: string;
    };

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

function resolveExistingProviders(
  existingParsed: unknown,
): Record<string, ExistingProviderConfig> | undefined {
  if (!isRecord(existingParsed) || !isRecord(existingParsed.providers)) {
    return undefined;
  }
  return existingParsed.providers as Record<string, ExistingProviderConfig>;
}

function collectMergePreservedApiKeys(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
}): ReadonlyMap<string, string> {
  if (params.mode !== "merge") {
    return new Map();
  }

  const existingProviders = resolveExistingProviders(params.existingParsed);
  if (!existingProviders) {
    return new Map();
  }

  const preserved = new Map<string, string>();
  for (const [providerKey, existingProvider] of Object.entries(existingProviders)) {
    const existingApiKey = existingProvider.apiKey;
    if (
      typeof existingApiKey !== "string" ||
      existingApiKey.length === 0 ||
      isNonSecretApiKeyMarker(existingApiKey, { includeEnvVarName: false })
    ) {
      continue;
    }

    const plannedApiKey = params.providers[providerKey]?.apiKey;
    if (plannedApiKey === existingApiKey) {
      preserved.set(providerKey, existingApiKey);
    }
  }

  return preserved;
}

function stripResolvedApiKeysForModelsJson(params: {
  providers: Record<string, ProviderConfig>;
  preservedApiKeys: ReadonlyMap<string, string>;
}): Record<string, ProviderConfig> {
  const sanitizedProviders: Record<string, ProviderConfig> = {};
  let changed = false;

  for (const [providerKey, provider] of Object.entries(params.providers)) {
    const apiKey = provider.apiKey;
    if (
      typeof apiKey !== "string" ||
      apiKey.length === 0 ||
      isNonSecretApiKeyMarker(apiKey) ||
      params.preservedApiKeys.get(providerKey) === apiKey
    ) {
      sanitizedProviders[providerKey] = provider;
      continue;
    }

    sanitizedProviders[providerKey] = {
      ...provider,
      apiKey: NON_ENV_SECRETREF_MARKER,
    };
    changed = true;
  }

  return changed ? sanitizedProviders : params.providers;
}

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
    return { action: "skip" };
  }

  const mode = cfg.models?.mode ?? "merge";
  const secretRefManagedProviders = new Set<string>();
  const normalizedProviders =
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? providers;
  const mergedProviders = resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
    providers: normalizedProviders,
    secretRefManagedProviders,
  });
  const normalizedMergedProviders =
    normalizeProviderCatalogModelsForConfig(mergedProviders) ?? mergedProviders;
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: normalizedMergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? normalizedMergedProviders;
  const finalProviders = applyNativeStreamingUsageCompat(secretEnforcedProviders);
  const preservedApiKeys = collectMergePreservedApiKeys({
    mode,
    existingParsed: params.existingParsed,
    providers: finalProviders,
  });
  const serializedProviders = stripResolvedApiKeysForModelsJson({
    providers: finalProviders,
    preservedApiKeys,
  });
  const nextContents = `${JSON.stringify({ providers: serializedProviders }, null, 2)}\n`;

  if (params.existingRaw === nextContents) {
    return { action: "noop" };
  }

  return {
    action: "write",
    contents: nextContents,
  };
}

export async function planOpenClawModelsJson(
  params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0],
): Promise<ModelsJsonPlan> {
  return planOpenClawModelsJsonWithDeps(params);
}
