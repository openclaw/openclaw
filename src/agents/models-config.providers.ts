import type { OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import {
  COPILOT_EDITOR_HEADERS,
  DEFAULT_COPILOT_API_BASE_URL,
  isGitHubPAT,
  resolveCopilotApiToken,
} from "../providers/github-copilot-token.js";
import { isRecord } from "../utils.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { discoverBedrockModels } from "./bedrock-discovery.js";
import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "./cloudflare-ai-gateway.js";
import {
  buildHuggingfaceProvider,
  buildKilocodeProviderWithDiscovery,
  buildVeniceProvider,
  buildVercelAiGatewayProvider,
  resolveOllamaApiBase,
} from "./models-config.providers.discovery.js";
import {
  buildBytePlusCodingProvider,
  buildBytePlusProvider,
  buildDoubaoCodingProvider,
  buildDoubaoProvider,
  buildKimiCodingProvider,
  buildKilocodeProvider,
  buildMinimaxPortalProvider,
  buildMinimaxProvider,
  buildModelStudioProvider,
  buildMoonshotProvider,
  buildNvidiaProvider,
  buildOpenAICodexProvider,
  buildOpenrouterProvider,
  buildQianfanProvider,
  buildQwenPortalProvider,
  buildSyntheticProvider,
  buildTogetherProvider,
  buildXiaomiProvider,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  XIAOMI_DEFAULT_MODEL_ID,
} from "./models-config.providers.static.js";
export {
  buildKimiCodingProvider,
  buildKilocodeProvider,
  buildNvidiaProvider,
  buildModelStudioProvider,
  buildQianfanProvider,
  buildXiaomiProvider,
  MODELSTUDIO_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  XIAOMI_DEFAULT_MODEL_ID,
} from "./models-config.providers.static.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
} from "../plugins/provider-discovery.js";
import {
  MINIMAX_OAUTH_MARKER,
  QWEN_OAUTH_MARKER,
  isNonSecretApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
  resolveNonEnvSecretRefHeaderValueMarker,
  resolveEnvSecretRefHeaderValueMarker,
} from "./model-auth-markers.js";
import { resolveAwsSdkEnvVarName, resolveEnvApiKey } from "./model-auth.js";
export { resolveOllamaApiBase } from "./models-config.providers.discovery.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function normalizeApiKeyConfig(value: string): string {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  return match?.[1] ?? trimmed;
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

export function normalizeGoogleModelId(id: string): string {
  if (id === "gemini-3-pro") {
    return "gemini-3-pro-preview";
  }
  if (id === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  if (id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemini-3.1-flash-lite") {
    return "gemini-3.1-flash-lite-preview";
  }
  // Preserve compatibility with earlier OpenClaw docs/config that pointed at a
  // non-existent Gemini Flash preview ID. Google's current Flash text model is
  // `gemini-3-flash-preview`.
  if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  return id;
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
        const fromEnv = resolveEnvApiKeyVarName(normalizedKey, env);
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

type ImplicitProviderContext = ImplicitProviderParams & {
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: ProviderApiKeyResolver;
};

type ImplicitProviderLoader = (
  ctx: ImplicitProviderContext,
) => Promise<Record<string, ProviderConfig> | undefined>;

function withApiKey(
  providerKey: string,
  build: (params: {
    apiKey: string;
    discoveryApiKey?: string;
    explicitProvider?: ProviderConfig;
  }) => ProviderConfig | Promise<ProviderConfig>,
): ImplicitProviderLoader {
  return async (ctx) => {
    const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(providerKey);
    if (!apiKey) {
      return undefined;
    }
    return {
      [providerKey]: await build({
        apiKey,
        discoveryApiKey,
        explicitProvider: ctx.explicitProviders?.[providerKey],
      }),
    };
  };
}

function withProfilePresence(
  providerKey: string,
  build: () => ProviderConfig | Promise<ProviderConfig>,
): ImplicitProviderLoader {
  return async (ctx) => {
    if (listProfilesForProvider(ctx.authStore, providerKey).length === 0) {
      return undefined;
    }
    return {
      [providerKey]: await build(),
    };
  };
}

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

const SIMPLE_IMPLICIT_PROVIDER_LOADERS: ImplicitProviderLoader[] = [
  withApiKey("minimax", async ({ apiKey }) => ({ ...buildMinimaxProvider(), apiKey })),
  withApiKey("moonshot", async ({ apiKey, explicitProvider }) => {
    const explicitBaseUrl = explicitProvider?.baseUrl;
    return {
      ...buildMoonshotProvider(),
      ...(typeof explicitBaseUrl === "string" && explicitBaseUrl.trim()
        ? { baseUrl: explicitBaseUrl.trim() }
        : {}),
      apiKey,
    };
  }),
  withApiKey("kimi-coding", async ({ apiKey, explicitProvider }) => {
    const builtInProvider = buildKimiCodingProvider();
    const explicitBaseUrl = explicitProvider?.baseUrl;
    const explicitHeaders = isRecord(explicitProvider?.headers)
      ? (explicitProvider.headers as ProviderConfig["headers"])
      : undefined;
    return {
      ...builtInProvider,
      ...(typeof explicitBaseUrl === "string" && explicitBaseUrl.trim()
        ? { baseUrl: explicitBaseUrl.trim() }
        : {}),
      ...(explicitHeaders
        ? {
            headers: {
              ...builtInProvider.headers,
              ...explicitHeaders,
            },
          }
        : {}),
      apiKey,
    };
  }),
  withApiKey("synthetic", async ({ apiKey }) => ({ ...buildSyntheticProvider(), apiKey })),
  withApiKey("venice", async ({ apiKey }) => ({ ...(await buildVeniceProvider()), apiKey })),
  withApiKey("xiaomi", async ({ apiKey }) => ({ ...buildXiaomiProvider(), apiKey })),
  withApiKey("vercel-ai-gateway", async ({ apiKey }) => ({
    ...(await buildVercelAiGatewayProvider()),
    apiKey,
  })),
  withApiKey("together", async ({ apiKey }) => ({ ...buildTogetherProvider(), apiKey })),
  withApiKey("huggingface", async ({ apiKey, discoveryApiKey }) => ({
    ...(await buildHuggingfaceProvider(discoveryApiKey)),
    apiKey,
  })),
  withApiKey("qianfan", async ({ apiKey }) => ({ ...buildQianfanProvider(), apiKey })),
  withApiKey("modelstudio", async ({ apiKey }) => ({ ...buildModelStudioProvider(), apiKey })),
  withApiKey("openrouter", async ({ apiKey }) => ({ ...buildOpenrouterProvider(), apiKey })),
  withApiKey("nvidia", async ({ apiKey }) => ({ ...buildNvidiaProvider(), apiKey })),
  withApiKey("kilocode", async ({ apiKey }) => ({
    ...(await buildKilocodeProviderWithDiscovery()),
    apiKey,
  })),
];

const PROFILE_IMPLICIT_PROVIDER_LOADERS: ImplicitProviderLoader[] = [
  async (ctx) => {
    const envKey = resolveEnvApiKeyVarName("minimax-portal", ctx.env);
    const hasProfiles = listProfilesForProvider(ctx.authStore, "minimax-portal").length > 0;
    if (!envKey && !hasProfiles) {
      return undefined;
    }
    return {
      "minimax-portal": {
        ...buildMinimaxPortalProvider(),
        apiKey: MINIMAX_OAUTH_MARKER,
      },
    };
  },
  withProfilePresence("qwen-portal", async () => ({
    ...buildQwenPortalProvider(),
    apiKey: QWEN_OAUTH_MARKER,
  })),
  withProfilePresence("openai-codex", async () => buildOpenAICodexProvider()),
];

const PAIRED_IMPLICIT_PROVIDER_LOADERS: ImplicitProviderLoader[] = [
  async (ctx) => {
    const volcengineKey = ctx.resolveProviderApiKey("volcengine").apiKey;
    if (!volcengineKey) {
      return undefined;
    }
    return {
      volcengine: { ...buildDoubaoProvider(), apiKey: volcengineKey },
      "volcengine-plan": {
        ...buildDoubaoCodingProvider(),
        apiKey: volcengineKey,
      },
    };
  },
  async (ctx) => {
    const byteplusKey = ctx.resolveProviderApiKey("byteplus").apiKey;
    if (!byteplusKey) {
      return undefined;
    }
    return {
      byteplus: { ...buildBytePlusProvider(), apiKey: byteplusKey },
      "byteplus-plan": {
        ...buildBytePlusCodingProvider(),
        apiKey: byteplusKey,
      },
    };
  },
];

async function resolveCloudflareAiGatewayImplicitProvider(
  ctx: ImplicitProviderContext,
): Promise<Record<string, ProviderConfig> | undefined> {
  const cloudflareProfiles = listProfilesForProvider(ctx.authStore, "cloudflare-ai-gateway");
  for (const profileId of cloudflareProfiles) {
    const cred = ctx.authStore.profiles[profileId];
    if (cred?.type !== "api_key") {
      continue;
    }
    const accountId = cred.metadata?.accountId?.trim();
    const gatewayId = cred.metadata?.gatewayId?.trim();
    if (!accountId || !gatewayId) {
      continue;
    }
    const baseUrl = resolveCloudflareAiGatewayBaseUrl({ accountId, gatewayId });
    if (!baseUrl) {
      continue;
    }
    const envVarApiKey = resolveEnvApiKeyVarName("cloudflare-ai-gateway", ctx.env);
    const profileApiKey = resolveApiKeyFromCredential(cred, ctx.env)?.apiKey;
    const apiKey = envVarApiKey ?? profileApiKey ?? "";
    if (!apiKey) {
      continue;
    }
    return {
      "cloudflare-ai-gateway": {
        baseUrl,
        api: "anthropic-messages",
        apiKey,
        models: [buildCloudflareAiGatewayModelDefinition()],
      },
    };
  }
  return undefined;
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
  for (const provider of byOrder[order]) {
    const result = await provider.discovery?.run({
      config: ctx.config ?? {},
      agentDir: ctx.agentDir,
      workspaceDir: ctx.workspaceDir,
      env: ctx.env,
      resolveProviderApiKey: (providerId) =>
        ctx.resolveProviderApiKey(providerId?.trim() || provider.id),
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
  const context: ImplicitProviderContext = {
    ...params,
    authStore,
    env,
    resolveProviderApiKey,
  };

  for (const loader of SIMPLE_IMPLICIT_PROVIDER_LOADERS) {
    mergeImplicitProviderSet(providers, await loader(context));
  }
  mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, "simple"));
  for (const loader of PROFILE_IMPLICIT_PROVIDER_LOADERS) {
    mergeImplicitProviderSet(providers, await loader(context));
  }
  mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, "profile"));
  for (const loader of PAIRED_IMPLICIT_PROVIDER_LOADERS) {
    mergeImplicitProviderSet(providers, await loader(context));
  }
  mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, "paired"));
  mergeImplicitProviderSet(providers, await resolveCloudflareAiGatewayImplicitProvider(context));
  mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, "late"));

  if (!providers["github-copilot"]) {
    const implicitCopilot = await resolveImplicitCopilotProvider({
      agentDir: params.agentDir,
      env,
    });
    if (implicitCopilot) {
      providers["github-copilot"] = implicitCopilot;
    }
  }

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

  return providers;
}

export async function resolveImplicitCopilotProvider(params: {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderConfig | null> {
  const env = params.env ?? process.env;
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const hasProfile = listProfilesForProvider(authStore, "github-copilot").length > 0;
  const envToken = env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;
  const githubToken = (envToken ?? "").trim();

  if (!hasProfile && !githubToken) {
    return null;
  }

  let selectedGithubToken = githubToken;
  if (!selectedGithubToken && hasProfile) {
    // Use the first available profile as a default for discovery (it will be
    // re-resolved per-run by the embedded runner).
    const profileId = listProfilesForProvider(authStore, "github-copilot")[0];
    const profile = profileId ? authStore.profiles[profileId] : undefined;
    if (profile && profile.type === "token") {
      selectedGithubToken = profile.token?.trim() ?? "";
      if (!selectedGithubToken) {
        const tokenRef = coerceSecretRef(profile.tokenRef);
        if (tokenRef?.source === "env" && tokenRef.id.trim()) {
          selectedGithubToken = (env[tokenRef.id] ?? process.env[tokenRef.id] ?? "").trim();
        }
      }
    }
  }

  let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
  // PATs are sent directly to the enterprise endpoint with editor headers.
  const needsEditorHeaders = selectedGithubToken ? isGitHubPAT(selectedGithubToken) : false;
  if (selectedGithubToken) {
    try {
      const token = await resolveCopilotApiToken({
        githubToken: selectedGithubToken,
        env,
      });
      baseUrl = token.baseUrl;
    } catch {
      baseUrl = DEFAULT_COPILOT_API_BASE_URL;
    }
  }

  // We deliberately do not write pi-coding-agent auth.json here.
  // OpenClaw keeps auth in auth-profiles and resolves runtime availability from that store.

  // We intentionally do NOT define custom models for Copilot in models.json.
  // pi-coding-agent treats providers with models as replacements requiring apiKey.
  // We only override baseUrl; the model list comes from pi-ai built-ins.
  return {
    baseUrl,
    models: [],
    ...(needsEditorHeaders ? { headers: { ...COPILOT_EDITOR_HEADERS } } : {}),
  } satisfies ProviderConfig;
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
