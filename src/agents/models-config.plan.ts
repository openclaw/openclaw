import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isRecord } from "../utils.js";
import { isNonSecretApiKeyMarker, isSecretRefHeaderValueMarker } from "./model-auth-markers.js";
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

type ExistingAuthSurfaces = {
  apiKey?: string;
  sensitiveHeaders: Map<string, string>;
};

const SENSITIVE_PROVIDER_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
  "x-secret-key",
  "secret-key",
]);
const SENSITIVE_PROVIDER_HEADER_NAME_FRAGMENTS = [
  "api-key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
];

function shouldPersistProviderApiKey(value: unknown): value is string {
  return typeof value === "string" && isNonSecretApiKeyMarker(value);
}

function isSensitiveProviderHeaderName(headerName: string): boolean {
  const normalized = headerName.trim().toLowerCase();
  return normalized !== "" && (
    SENSITIVE_PROVIDER_HEADER_NAMES.has(normalized) ||
    SENSITIVE_PROVIDER_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
}

function shouldPersistSensitiveHeaderValue(value: unknown): value is string {
  return typeof value === "string" && isSecretRefHeaderValueMarker(value);
}

function collectExistingAuthSurfaces(existingParsed: unknown): Map<string, ExistingAuthSurfaces> {
  const existingProviders =
    isRecord(existingParsed) && isRecord(existingParsed.providers)
      ? (existingParsed.providers as Record<string, ExistingProviderConfig>)
      : undefined;
  const out = new Map<string, ExistingAuthSurfaces>();
  for (const [providerKey, provider] of Object.entries(existingProviders ?? {})) {
    if (!isRecord(provider)) {
      continue;
    }
    const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : undefined;
    const sensitiveHeaders = new Map<string, string>();
    const headers = isRecord(provider.headers)
      ? (provider.headers as Record<string, unknown>)
      : undefined;
    for (const [headerName, headerValue] of Object.entries(headers ?? {})) {
      if (isSensitiveProviderHeaderName(headerName) && typeof headerValue === "string") {
        sensitiveHeaders.set(headerName.trim().toLowerCase(), headerValue);
      }
    }
    if (apiKey !== undefined || sensitiveHeaders.size > 0) {
      out.set(providerKey, { ...(apiKey !== undefined ? { apiKey } : {}), sensitiveHeaders });
    }
  }
  return out;
}

function stripPromptVisibleProviderSecrets(
  providers: Record<string, ProviderConfig>,
  opts: { existingAuthSurfaces?: ReadonlyMap<string, ExistingAuthSurfaces> } = {},
): Record<string, ProviderConfig> {
  let nextProviders: Record<string, ProviderConfig> | undefined;

  for (const [providerKey, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    let nextProvider: ProviderConfig | undefined;
    const existingAuth = opts.existingAuthSurfaces?.get(providerKey);
    const apiKey = (provider as { apiKey?: unknown }).apiKey;
    if (
      apiKey !== undefined &&
      !shouldPersistProviderApiKey(apiKey) &&
      !(typeof apiKey === "string" && existingAuth?.apiKey === apiKey)
    ) {
      nextProvider = { ...provider };
      delete (nextProvider as { apiKey?: unknown }).apiKey;
    }

    const currentProvider = nextProvider ?? provider;
    const headers = isRecord(currentProvider.headers)
      ? (currentProvider.headers as Record<string, unknown>)
      : undefined;
    if (headers) {
      let nextHeaders: Record<string, NonNullable<ProviderConfig["headers"]>[string]> | undefined;
      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (
          !isSensitiveProviderHeaderName(headerName) ||
          shouldPersistSensitiveHeaderValue(headerValue) ||
          (typeof headerValue === "string" &&
            existingAuth?.sensitiveHeaders.get(headerName.trim().toLowerCase()) === headerValue)
        ) {
          continue;
        }
        nextHeaders ??= {
          ...(headers as Record<string, NonNullable<ProviderConfig["headers"]>[string]>),
        };
        delete nextHeaders[headerName];
      }
      if (nextHeaders) {
        nextProvider = { ...(nextProvider ?? provider) };
        if (Object.keys(nextHeaders).length > 0) {
          nextProvider.headers = nextHeaders;
        } else {
          delete (nextProvider as { headers?: unknown }).headers;
        }
      }
    }

    if (nextProvider) {
      nextProviders ??= { ...providers };
      nextProviders[providerKey] = nextProvider;
    }
  }

  return nextProviders ?? providers;
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
  const normalizedPostMergeProviders =
    normalizeProviders({
      providers: mergedProviders,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? mergedProviders;
  const normalizedMergedProviders =
    normalizeProviderCatalogModelsForConfig(normalizedPostMergeProviders, {
      manifestPlugins,
    }) ?? normalizedPostMergeProviders;
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: normalizedMergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? normalizedMergedProviders;
  const finalProviders = applyNativeStreamingUsageCompat(secretEnforcedProviders);
  const persistedProviders = stripPromptVisibleProviderSecrets(finalProviders, {
    existingAuthSurfaces:
      mode === "merge" ? collectExistingAuthSurfaces(params.existingParsed) : undefined,
  });
  const nextContents = `${JSON.stringify({ providers: persistedProviders }, null, 2)}\n`;

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
