import { buildAnthropicVertexProvider } from "../../extensions/anthropic-vertex/provider-catalog.js";
import {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
} from "../../extensions/qianfan/provider-catalog.js";
import { XIAOMI_DEFAULT_MODEL_ID } from "../../extensions/xiaomi/provider-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { hasAnthropicVertexAvailableAuth } from "./anthropic-vertex-provider.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { discoverBedrockModels } from "./bedrock-discovery.js";
import { normalizeGoogleModelId, normalizeXaiModelId } from "./model-id-normalization.js";
import { resolveOllamaApiBase } from "./models-config.providers.discovery.js";
export { buildKimiCodingProvider } from "../../extensions/kimi-coding/provider-catalog.js";
export { buildKilocodeProvider } from "../../extensions/kilocode/provider-catalog.js";
export {
  MODELSTUDIO_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  buildModelStudioProvider,
} from "../../extensions/modelstudio/provider-catalog.js";
export { buildNvidiaProvider } from "../../extensions/nvidia/provider-catalog.js";
export {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  buildQianfanProvider,
} from "../../extensions/qianfan/provider-catalog.js";
export {
  XIAOMI_DEFAULT_MODEL_ID,
  buildXiaomiProvider,
} from "../../extensions/xiaomi/provider-catalog.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import {
  isNonSecretApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
  resolveNonEnvSecretRefHeaderValueMarker,
  resolveEnvSecretRefHeaderValueMarker,
} from "./model-auth-markers.js";
import { resolveAwsSdkEnvVarName, resolveEnvApiKey } from "./model-auth.js";
export { resolveOllamaApiBase } from "./models-config.providers.discovery.js";
export { normalizeGoogleModelId, normalizeXaiModelId };

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

const MOONSHOT_NATIVE_BASE_URLS = new Set([
  "https://api.moonshot.ai/v1",
  "https://api.moonshot.cn/v1",
]);
const MODELSTUDIO_NATIVE_BASE_URLS = new Set([
  "https://coding-intl.dashscope.aliyuncs.com/v1",
  "https://coding.dashscope.aliyuncs.com/v1",
]);

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function normalizeApiKeyConfig(value: string): string {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function normalizeProviderBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

function withStreamingUsageCompat(provider: ProviderConfig): ProviderConfig {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return provider;
  }

  let changed = false;
  const models = provider.models.map((model) => {
    if (model.compat?.supportsUsageInStreaming !== undefined) {
      return model;
    }
    changed = true;
    return {
      ...model,
      compat: {
        ...model.compat,
        supportsUsageInStreaming: true,
      },
    };
  });

  return changed ? { ...provider, models } : provider;
}

export function applyNativeStreamingUsageCompat(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let changed = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  for (const [providerKey, provider] of Object.entries(providers)) {
    const normalizedBaseUrl = normalizeProviderBaseUrl(provider.baseUrl);
    const isNativeMoonshot =
      providerKey === "moonshot" && MOONSHOT_NATIVE_BASE_URLS.has(normalizedBaseUrl);
    const isNativeModelStudio =
      providerKey === "modelstudio" && MODELSTUDIO_NATIVE_BASE_URLS.has(normalizedBaseUrl);
    const nextProvider =
      isNativeMoonshot || isNativeModelStudio ? withStreamingUsageCompat(provider) : provider;
    nextProviders[providerKey] = nextProvider;
    changed ||= nextProvider !== provider;
  }

  return changed ? nextProviders : providers;
}

function resolveEnvApiKeyVarName(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const resolved = resolveEnvApiKey(provider, env);
  if (!resolved) {
    return undefined;
  }
  const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
  return match ? match[1] : undefined;
}

function resolveAwsSdkApiKeyVarName(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAwsSdkEnvVarName(env) ?? "AWS_PROFILE";
}

function normalizeHeaderValues(params: {
  headers: ProviderConfig["headers"] | undefined;
  secretDefaults: SecretDefaults | undefined;
}): { headers: ProviderConfig["headers"] | undefined; mutated: boolean } {
  const { headers } = params;
  if (!headers) {
    return { headers, mutated: false };
  }
  let mutated = false;
  const nextHeaders: Record<string, NonNullable<ProviderConfig["headers"]>[string]> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const resolvedRef = resolveSecretInputRef({
      value: headerValue,
      defaults: params.secretDefaults,
    }).ref;
    if (!resolvedRef || !resolvedRef.id.trim()) {
      nextHeaders[headerName] = headerValue;
      continue;
    }
    mutated = true;
    nextHeaders[headerName] =
      resolvedRef.source === "env"
        ? resolveEnvSecretRefHeaderValueMarker(resolvedRef.id)
        : resolveNonEnvSecretRefHeaderValueMarker(resolvedRef.source);
  }
  if (!mutated) {
    return { headers, mutated: false };
  }
  return { headers: nextHeaders, mutated: true };
}

type ProfileApiKeyResolution = {
  apiKey: string;
  source: "plaintext" | "env-ref" | "non-env-ref";
  /** Optional secret value that may be used for provider discovery only. */
  discoveryApiKey?: string;
};

function toDiscoveryApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || isNonSecretApiKeyMarker(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function resolveApiKeyFromCredential(
  cred: ReturnType<typeof ensureAuthProfileStore>["profiles"][string] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProfileApiKeyResolution | undefined {
  if (!cred) {
    return undefined;
  }
  if (cred.type === "api_key") {
    const keyRef = coerceSecretRef(cred.keyRef);
    if (keyRef && keyRef.id.trim()) {
      if (keyRef.source === "env") {
        const envVar = keyRef.id.trim();
        return {
          apiKey: envVar,
          source: "env-ref",
          discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        };
      }
      return {
        apiKey: resolveNonEnvSecretRefApiKeyMarker(keyRef.source),
        source: "non-env-ref",
      };
    }
    if (cred.key?.trim()) {
      return {
        apiKey: cred.key,
        source: "plaintext",
        discoveryApiKey: toDiscoveryApiKey(cred.key),
      };
    }
    return undefined;
  }
  if (cred.type === "token") {
    const tokenRef = coerceSecretRef(cred.tokenRef);
    if (tokenRef && tokenRef.id.trim()) {
      if (tokenRef.source === "env") {
        const envVar = tokenRef.id.trim();
        return {
          apiKey: envVar,
          source: "env-ref",
          discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        };
      }
      return {
        apiKey: resolveNonEnvSecretRefApiKeyMarker(tokenRef.source),
        source: "non-env-ref",
      };
    }
    if (cred.token?.trim()) {
      return {
        apiKey: cred.token,
        source: "plaintext",
        discoveryApiKey: toDiscoveryApiKey(cred.token),
      };
    }
  }
  return undefined;
}

function resolveApiKeyFromProfiles(params: {
  provider: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
  env?: NodeJS.ProcessEnv;
}): ProfileApiKeyResolution | undefined {
  const ids = listProfilesForProvider(params.store, params.provider);
  for (const id of ids) {
    const resolved = resolveApiKeyFromCredential(params.store.profiles[id], params.env);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

const ANTIGRAVITY_BARE_PRO_IDS = new Set(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"]);

export function normalizeAntigravityModelId(id: string): string {
  if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) {
    return `${id}-low`;
  }
  return id;
}

function normalizeProviderModels(
  provider: ProviderConfig,
  normalizeId: (id: string) => string,
): ProviderConfig {
  let mutated = false;
  const models = provider.models.map((model) => {
    const nextId = normalizeId(model.id);
    if (nextId === model.id) {
      return model;
    }
    mutated = true;
    return { ...model, id: nextId };
  });
  return mutated ? { ...provider, models } : provider;
}

function normalizeGoogleProvider(provider: ProviderConfig): ProviderConfig {
  return normalizeProviderModels(provider, normalizeGoogleModelId);
}

function normalizeAntigravityProvider(provider: ProviderConfig): ProviderConfig {
  return normalizeProviderModels(provider, normalizeAntigravityModelId);
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
    const configuredApiKey = normalizedProvider.apiKey;
    const configuredApiKeyRef = resolveSecretInputRef({
      value: configuredApiKey,
      defaults: params.secretDefaults,
    }).ref;
    const profileApiKey = resolveApiKeyFromProfiles({
      provider: normalizedKey,
      store: authStore,
      env,
    });

    if (configuredApiKeyRef && configuredApiKeyRef.id.trim()) {
      const marker =
        configuredApiKeyRef.source === "env"
          ? configuredApiKeyRef.id.trim()
          : resolveNonEnvSecretRefApiKeyMarker(configuredApiKeyRef.source);
      if (normalizedProvider.apiKey !== marker) {
        mutated = true;
        normalizedProvider = { ...normalizedProvider, apiKey: marker };
      }
      params.secretRefManagedProviders?.add(normalizedKey);
    } else if (typeof configuredApiKey === "string") {
      // Fix common misconfig: apiKey set to "${ENV_VAR}" instead of "ENV_VAR".
      const normalizedConfiguredApiKey = normalizeApiKeyConfig(configuredApiKey);
      if (normalizedConfiguredApiKey !== configuredApiKey) {
        mutated = true;
        normalizedProvider = {
          ...normalizedProvider,
          apiKey: normalizedConfiguredApiKey,
        };
      }
      if (isNonSecretApiKeyMarker(normalizedConfiguredApiKey)) {
        params.secretRefManagedProviders?.add(normalizedKey);
      }
      if (
        profileApiKey &&
        profileApiKey.source !== "plaintext" &&
        normalizedConfiguredApiKey === profileApiKey.apiKey
      ) {
        params.secretRefManagedProviders?.add(normalizedKey);
      }
    }

    // Reverse-lookup: if apiKey looks like a resolved secret value (not an env
    // var name), check whether it matches the canonical env var for this provider.
    // This prevents resolveConfigEnvVars()-resolved secrets from being persisted
    // to models.json as plaintext. (Fixes #38757)
    const currentApiKey = normalizedProvider.apiKey;
    if (
      typeof currentApiKey === "string" &&
      currentApiKey.trim() &&
      !ENV_VAR_NAME_RE.test(currentApiKey.trim())
    ) {
      const envVarName = resolveEnvApiKeyVarName(normalizedKey, env);
      if (envVarName && env[envVarName] === currentApiKey) {
        mutated = true;
        normalizedProvider = { ...normalizedProvider, apiKey: envVarName };
        params.secretRefManagedProviders?.add(normalizedKey);
      }
    }

    // If a provider defines models, pi's ModelRegistry requires apiKey to be set.
    // Fill it from the environment or auth profiles when possible.
    const hasModels =
      Array.isArray(normalizedProvider.models) && normalizedProvider.models.length > 0;
    const normalizedApiKey = normalizeOptionalSecretInput(normalizedProvider.apiKey);
    const hasConfiguredApiKey = Boolean(normalizedApiKey || normalizedProvider.apiKey);
    if (hasModels && !hasConfiguredApiKey) {
      const authMode =
        normalizedProvider.auth ?? (normalizedKey === "amazon-bedrock" ? "aws-sdk" : undefined);
      if (authMode === "aws-sdk") {
        const apiKey = resolveAwsSdkApiKeyVarName(env);
        mutated = true;
        normalizedProvider = { ...normalizedProvider, apiKey };
      } else {
        const fromEnv =
          normalizedKey === "anthropic-vertex"
            ? resolveEnvApiKey(normalizedKey, env)?.apiKey
            : resolveEnvApiKeyVarName(normalizedKey, env);
        const apiKey = fromEnv ?? profileApiKey?.apiKey;
        if (apiKey?.trim()) {
          if (profileApiKey && profileApiKey.source !== "plaintext") {
            params.secretRefManagedProviders?.add(normalizedKey);
          }
          mutated = true;
          normalizedProvider = { ...normalizedProvider, apiKey };
        }
      }
    }

    if (normalizedKey === "google" || normalizedKey === "google-vertex") {
      const googleNormalized = normalizeGoogleProvider(normalizedProvider);
      if (googleNormalized !== normalizedProvider) {
        mutated = true;
      }
      normalizedProvider = googleNormalized;
    }

    if (normalizedKey === "google-antigravity") {
      const antigravityNormalized = normalizeAntigravityProvider(normalizedProvider);
      if (antigravityNormalized !== normalizedProvider) {
        mutated = true;
      }
      normalizedProvider = antigravityNormalized;
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

type ImplicitProviderParams = {
  agentDir: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders?: Record<string, ProviderConfig> | null;
};

type ProviderApiKeyResolver = (provider: string) => {
  apiKey: string | undefined;
  discoveryApiKey?: string;
};

type ProviderAuthResolver = (
  provider: string,
  options?: { oauthMarker?: string },
) => {
  apiKey: string | undefined;
  discoveryApiKey?: string;
  mode: "api_key" | "oauth" | "token" | "none";
  source: "env" | "profile" | "none";
  profileId?: string;
};

type ImplicitProviderContext = ImplicitProviderParams & {
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: ProviderApiKeyResolver;
  resolveProviderAuth: ProviderAuthResolver;
};

function mergeImplicitProviderSet(
  target: Record<string, ProviderConfig>,
  additions: Record<string, ProviderConfig> | undefined,
): void {
  if (!additions) {
    return;
  }
  for (const [key, value] of Object.entries(additions)) {
    target[key] = value;
  }
}

async function resolvePluginImplicitProviders(
  ctx: ImplicitProviderContext,
  order: import("../plugins/types.js").ProviderDiscoveryOrder,
): Promise<Record<string, ProviderConfig> | undefined> {
  const providers = resolvePluginDiscoveryProviders({
    config: ctx.config,
    workspaceDir: ctx.workspaceDir,
    env: ctx.env,
  });
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const discovered: Record<string, ProviderConfig> = {};
  const catalogConfig =
    ctx.explicitProviders && Object.keys(ctx.explicitProviders).length > 0
      ? {
          ...ctx.config,
          models: {
            ...ctx.config?.models,
            providers: {
              ...ctx.config?.models?.providers,
              ...ctx.explicitProviders,
            },
          },
        }
      : (ctx.config ?? {});
  for (const provider of byOrder[order]) {
    const result = await runProviderCatalog({
      provider,
      config: catalogConfig,
      agentDir: ctx.agentDir,
      workspaceDir: ctx.workspaceDir,
      env: ctx.env,
      resolveProviderApiKey: (providerId) =>
        ctx.resolveProviderApiKey(providerId?.trim() || provider.id),
      resolveProviderAuth: (providerId, options) =>
        ctx.resolveProviderAuth(providerId?.trim() || provider.id, options),
    });
    mergeImplicitProviderSet(
      discovered,
      normalizePluginDiscoveryResult({
        provider,
        result,
      }),
    );
  }
  return Object.keys(discovered).length > 0 ? discovered : undefined;
}

export async function resolveImplicitProviders(
  params: ImplicitProviderParams,
): Promise<ModelsConfig["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  const env = params.env ?? process.env;
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const resolveProviderApiKey: ProviderApiKeyResolver = (
    provider: string,
  ): { apiKey: string | undefined; discoveryApiKey?: string } => {
    const envVar = resolveEnvApiKeyVarName(provider, env);
    if (envVar) {
      return {
        apiKey: envVar,
        discoveryApiKey: toDiscoveryApiKey(env[envVar]),
      };
    }
    const fromProfiles = resolveApiKeyFromProfiles({ provider, store: authStore, env });
    return {
      apiKey: fromProfiles?.apiKey,
      discoveryApiKey: fromProfiles?.discoveryApiKey,
    };
  };
  const resolveProviderAuth: ProviderAuthResolver = (
    provider: string,
    options?: { oauthMarker?: string },
  ) => {
    const envVar = resolveEnvApiKeyVarName(provider, env);
    if (envVar) {
      return {
        apiKey: envVar,
        discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        mode: "api_key",
        source: "env",
      };
    }

    const ids = listProfilesForProvider(authStore, provider);
    let oauthCandidate:
      | {
          apiKey: string | undefined;
          discoveryApiKey?: string;
          mode: "oauth";
          source: "profile";
          profileId: string;
        }
      | undefined;
    for (const id of ids) {
      const cred = authStore.profiles[id];
      if (!cred) {
        continue;
      }
      if (cred.type === "oauth") {
        oauthCandidate ??= {
          apiKey: options?.oauthMarker,
          discoveryApiKey: toDiscoveryApiKey(cred.access),
          mode: "oauth",
          source: "profile",
          profileId: id,
        };
        continue;
      }
      const resolved = resolveApiKeyFromCredential(cred, env);
      if (!resolved) {
        continue;
      }
      return {
        apiKey: resolved.apiKey,
        discoveryApiKey: resolved.discoveryApiKey,
        mode: cred.type,
        source: "profile",
        profileId: id,
      };
    }
    if (oauthCandidate) {
      return oauthCandidate;
    }

    return {
      apiKey: undefined,
      discoveryApiKey: undefined,
      mode: "none",
      source: "none",
    };
  };
  const context: ImplicitProviderContext = {
    ...params,
    authStore,
    env,
    resolveProviderApiKey,
    resolveProviderAuth,
  };

  mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, "simple"));
  mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, "profile"));
  mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, "paired"));
  mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, "late"));

  const implicitBedrock = await resolveImplicitBedrockProvider({
    agentDir: params.agentDir,
    config: params.config,
    env,
  });
  if (implicitBedrock) {
    const existing = providers["amazon-bedrock"];
    providers["amazon-bedrock"] = existing
      ? {
          ...implicitBedrock,
          ...existing,
          models:
            Array.isArray(existing.models) && existing.models.length > 0
              ? existing.models
              : implicitBedrock.models,
        }
      : implicitBedrock;
  }

  const implicitAnthropicVertex = resolveImplicitAnthropicVertexProvider({ env });
  if (implicitAnthropicVertex) {
    const existing = providers["anthropic-vertex"];
    providers["anthropic-vertex"] = existing
      ? {
          ...implicitAnthropicVertex,
          ...existing,
          models:
            Array.isArray(existing.models) && existing.models.length > 0
              ? existing.models
              : implicitAnthropicVertex.models,
        }
      : implicitAnthropicVertex;
  }

  return providers;
}

export function resolveImplicitAnthropicVertexProvider(params: {
  env?: NodeJS.ProcessEnv;
}): ProviderConfig | null {
  const env = params.env ?? process.env;
  if (!hasAnthropicVertexAvailableAuth(env)) {
    return null;
  }

  return buildAnthropicVertexProvider({ env });
}
export async function resolveImplicitBedrockProvider(params: {
  agentDir: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderConfig | null> {
  const env = params.env ?? process.env;
  const discoveryConfig = params.config?.models?.bedrockDiscovery;
  const enabled = discoveryConfig?.enabled;
  const hasAwsCreds = resolveAwsSdkEnvVarName(env) !== undefined;
  if (enabled === false) {
    return null;
  }
  if (enabled !== true && !hasAwsCreds) {
    return null;
  }

  const region = discoveryConfig?.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
  const models = await discoverBedrockModels({
    region,
    config: discoveryConfig,
  });
  if (models.length === 0) {
    return null;
  }

  return {
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
    models,
  } satisfies ProviderConfig;
}
