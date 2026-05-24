import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isRecord } from "../utils.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import { NON_ENV_SECRETREF_MARKER, isNonSecretApiKeyMarker } from "./model-auth-markers.js";
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

function collectPlaintextApiKeysFromProviders(
  providers: unknown,
): ReadonlyMap<string, string> {
  const plaintextApiKeys = new Map<string, string>();
  if (!isRecord(providers)) {
    return plaintextApiKeys;
  }
  for (const [providerKey, entry] of Object.entries(providers)) {
    if (!isRecord(entry)) {
      continue;
    }
    const apiKey = entry.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      continue;
    }
    // Existing apiKeys that are already non-secret markers don't need
    // preservation tracking — leaving them alone falls out naturally from
    // the marker check below. We only track non-marker (user-authored
    // plaintext) values, which are the ones the sanitizer must not clobber.
    if (isNonSecretApiKeyMarker(apiKey)) {
      continue;
    }
    plaintextApiKeys.set(providerKey, apiKey);
  }
  return plaintextApiKeys;
}

function collectPreservedApiKeysForModelsJson(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  sourceProviders: unknown;
  providersBeforeMerge: Record<string, ProviderConfig>;
  mergedProviders: Record<string, ProviderConfig>;
}): ReadonlyMap<string, string> {
  const preserved = new Map<string, string>(
    collectPlaintextApiKeysFromProviders(params.sourceProviders),
  );
  if (params.mode !== "merge" || !isRecord(params.existingParsed)) {
    return preserved;
  }
  const existingProviders = isRecord(params.existingParsed.providers)
    ? params.existingParsed.providers
    : {};
  const existingPlaintextApiKeys = collectPlaintextApiKeysFromProviders(existingProviders);
  for (const [providerKey, apiKey] of existingPlaintextApiKeys) {
    const providerBeforeMerge = params.providersBeforeMerge[providerKey];
    const beforeMergeApiKey = providerBeforeMerge?.apiKey;
    if (typeof beforeMergeApiKey === "string" && beforeMergeApiKey.trim()) {
      continue;
    }
    if (params.mergedProviders[providerKey]?.apiKey === apiKey) {
      preserved.set(providerKey, apiKey);
    }
  }
  return preserved;
}

function stripResolvedApiKeysForModelsJson(
  providers: Record<string, ProviderConfig>,
  preservedPlaintextApiKeys: ReadonlyMap<string, string>,
): Record<string, ProviderConfig> {
  let changed = false;
  const sanitizedProviders: Record<string, ProviderConfig> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    const apiKey = provider.apiKey;
    // Preserve user-authored plaintext that already lived in models.json.
    // mergeWithExistingProviderSecrets intentionally carries these forward,
    // and replacing them with a non-usable marker would break custom
    // providers whose only credential lives in the existing models.json.
    if (typeof apiKey === "string" && preservedPlaintextApiKeys.get(providerKey) === apiKey) {
      sanitizedProviders[providerKey] = provider;
      continue;
    }
    if (typeof apiKey === "string" && apiKey.trim() && !isNonSecretApiKeyMarker(apiKey)) {
      sanitizedProviders[providerKey] = { ...provider, apiKey: NON_ENV_SECRETREF_MARKER };
      changed = true;
      continue;
    }

    sanitizedProviders[providerKey] = provider;
  }

  return changed ? sanitizedProviders : providers;
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
  const preservedPlaintextApiKeys = collectPreservedApiKeysForModelsJson({
    mode,
    existingParsed: params.existingParsed,
    sourceProviders: params.sourceConfigForSecrets?.models?.providers ?? cfg.models?.providers,
    providersBeforeMerge: normalizedProviders,
    mergedProviders,
  });
  const finalProviders = stripResolvedApiKeysForModelsJson(
    applyNativeStreamingUsageCompat(secretEnforcedProviders),
    preservedPlaintextApiKeys,
  );
  const nextContents = `${JSON.stringify({ providers: finalProviders }, null, 2)}\n`;

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
