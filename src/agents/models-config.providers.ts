import {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
} from "../../extensions/qianfan/provider-catalog.js";
import { XIAOMI_DEFAULT_MODEL_ID } from "../../extensions/xiaomi/provider-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { discoverBedrockModels } from "./bedrock-discovery.js";
import { normalizeGoogleModelId } from "./model-id-normalization.js";
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
export { normalizeGoogleModelId };

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

function buildMinimaxModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ProviderModelConfig["input"];
}): ProviderModelConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.input,
    cost: MINIMAX_API_COST,
    contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
  };
}

function buildMinimaxTextModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
}): ProviderModelConfig {
  return buildMinimaxModel({ ...params, input: ["text"] });
}

const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/anthropic";
export const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
const XIAOMI_DEFAULT_CONTEXT_WINDOW = 262144;
const XIAOMI_DEFAULT_MAX_TOKENS = 8192;
const XIAOMI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_DEFAULT_MODEL_ID = "k2p5";
const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262144;
const KIMI_CODING_DEFAULT_MAX_TOKENS = 32768;
const KIMI_CODING_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const QWEN_PORTAL_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_PORTAL_OAUTH_PLACEHOLDER = "qwen-oauth";
const QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW = 128000;
const QWEN_PORTAL_DEFAULT_MAX_TOKENS = 8192;
const QWEN_PORTAL_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OLLAMA_BASE_URL = OLLAMA_NATIVE_BASE_URL;
const OLLAMA_API_BASE_URL = OLLAMA_BASE_URL;
const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_SHOW_MAX_MODELS = 200;
const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
const OLLAMA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL_ID = "auto";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 200000;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const VLLM_BASE_URL = "http://127.0.0.1:8000/v1";
const VLLM_DEFAULT_CONTEXT_WINDOW = 128000;
const VLLM_DEFAULT_MAX_TOKENS = 8192;
const VLLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const AIPING_BASE_URL = "https://aiping.cn/api/v1";
export const AIPING_DEFAULT_MODEL_ID = "DeepSeek-V3.2";
const AIPING_DEFAULT_CONTEXT_WINDOW = 131072;
const AIPING_DEFAULT_MAX_TOKENS = 8192;
const AIPING_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
export const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
const QIANFAN_DEFAULT_CONTEXT_WINDOW = 98304;
const QIANFAN_DEFAULT_MAX_TOKENS = 32768;
const QIANFAN_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_DEFAULT_MODEL_ID = "nvidia/llama-3.1-nemotron-70b-instruct";
const NVIDIA_DEFAULT_CONTEXT_WINDOW = 131072;
const NVIDIA_DEFAULT_MAX_TOKENS = 4096;
const NVIDIA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const log = createSubsystemLogger("agents/model-providers");

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

type VllmModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

/**
 * Derive the Ollama native API base URL from a configured base URL.
 *
 * Users typically configure `baseUrl` with a `/v1` suffix (e.g.
 * `http://192.168.20.14:11434/v1`) for the OpenAI-compatible endpoint.
 * The native Ollama API lives at the root (e.g. `/api/tags`), so we
 * strip the `/v1` suffix when present.
 */
export function resolveOllamaApiBase(configuredBaseUrl?: string): string {
  if (!configuredBaseUrl) {
    return OLLAMA_API_BASE_URL;
  }
  // Strip trailing slash, then strip /v1 suffix if present
  const trimmed = configuredBaseUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  try {
    const response = await fetch(`${apiBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as { model_info?: Record<string, unknown> };
    if (!data.model_info) {
      return undefined;
    }
    for (const [key, value] of Object.entries(data.model_info)) {
      if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
        const contextWindow = Math.floor(value);
        if (contextWindow > 0) {
          return contextWindow;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function discoverOllamaModels(
  baseUrl?: string,
  opts?: { quiet?: boolean },
): Promise<ModelDefinitionConfig[]> {
  // Skip Ollama discovery in test environments
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const response = await fetch(`${apiBase}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (!opts?.quiet) {
        log.warn(`Failed to discover Ollama models: ${response.status}`);
      }
      return [];
    }
    const data = (await response.json()) as OllamaTagsResponse;
    if (!data.models || data.models.length === 0) {
      log.debug("No Ollama models found on local instance");
      return [];
    }
    const modelsToInspect = data.models.slice(0, OLLAMA_SHOW_MAX_MODELS);
    if (modelsToInspect.length < data.models.length && !opts?.quiet) {
      log.warn(
        `Capping Ollama /api/show inspection to ${OLLAMA_SHOW_MAX_MODELS} models (received ${data.models.length})`,
      );
    }
    const discovered: ModelDefinitionConfig[] = [];
    for (let index = 0; index < modelsToInspect.length; index += OLLAMA_SHOW_CONCURRENCY) {
      const batch = modelsToInspect.slice(index, index + OLLAMA_SHOW_CONCURRENCY);
      const batchDiscovered = await Promise.all(
        batch.map(async (model) => {
          const modelId = model.name;
          const contextWindow = await queryOllamaContextWindow(apiBase, modelId);
          const isReasoning =
            modelId.toLowerCase().includes("r1") || modelId.toLowerCase().includes("reasoning");
          return {
            id: modelId,
            name: modelId,
            reasoning: isReasoning,
            input: ["text"],
            cost: OLLAMA_DEFAULT_COST,
            contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
            maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
          } satisfies ModelDefinitionConfig;
        }),
      );
      discovered.push(...batchDiscovered);
    }
    return discovered;
  } catch (error) {
    if (!opts?.quiet) {
      log.warn(`Failed to discover Ollama models: ${String(error)}`);
    }
    return [];
  }
}

async function discoverVllmModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelDefinitionConfig[]> {
  // Skip vLLM discovery in test environments
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }

  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const url = `${trimmedBaseUrl}/models`;

  try {
    const trimmedApiKey = apiKey?.trim();
    const response = await fetch(url, {
      headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`Failed to discover vLLM models: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as VllmModelsResponse;
    const models = data.data ?? [];
    if (models.length === 0) {
      log.warn("No vLLM models found on local instance");
      return [];
    }

    return models
      .map((m) => ({ id: typeof m.id === "string" ? m.id.trim() : "" }))
      .filter((m) => Boolean(m.id))
      .map((m) => {
        const modelId = m.id;
        const lower = modelId.toLowerCase();
        const isReasoning =
          lower.includes("r1") || lower.includes("reasoning") || lower.includes("think");
        return {
          id: modelId,
          name: modelId,
          reasoning: isReasoning,
          input: ["text"],
          cost: VLLM_DEFAULT_COST,
          contextWindow: VLLM_DEFAULT_CONTEXT_WINDOW,
          maxTokens: VLLM_DEFAULT_MAX_TOKENS,
        } satisfies ModelDefinitionConfig;
      });
  } catch (error) {
    log.warn(`Failed to discover vLLM models: ${String(error)}`);
    return [];
  }
}

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

function buildMinimaxProvider(): ProviderConfig {
  return {
    baseUrl: MINIMAX_PORTAL_BASE_URL,
    api: "anthropic-messages",
    authHeader: true,
    models: [
      buildMinimaxModel({
        id: MINIMAX_DEFAULT_VISION_MODEL_ID,
        name: "MiniMax VL 01",
        reasoning: false,
        input: ["text", "image"],
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5",
        name: "MiniMax M2.5",
        reasoning: true,
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5-highspeed",
        name: "MiniMax M2.5 Highspeed",
        reasoning: true,
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5-Lightning",
        name: "MiniMax M2.5 Lightning",
        reasoning: true,
      }),
    ],
  };
}

function buildMinimaxPortalProvider(): ProviderConfig {
  return {
    baseUrl: MINIMAX_PORTAL_BASE_URL,
    api: "anthropic-messages",
    authHeader: true,
    models: [
      buildMinimaxTextModel({
        id: MINIMAX_DEFAULT_MODEL_ID,
        name: "MiniMax M2.5",
        reasoning: true,
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5-highspeed",
        name: "MiniMax M2.5 Highspeed",
        reasoning: true,
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5-Lightning",
        name: "MiniMax M2.5 Lightning",
        reasoning: true,
      }),
    ],
  };
}

function buildMoonshotProvider(): ProviderConfig {
  return {
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: MOONSHOT_DEFAULT_MODEL_ID,
        name: "Kimi K2.5",
        reasoning: false,
        input: ["text", "image"],
        cost: MOONSHOT_DEFAULT_COST,
        contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export function buildKimiCodingProvider(): ProviderConfig {
  return {
    baseUrl: KIMI_CODING_BASE_URL,
    api: "anthropic-messages",
    models: [
      {
        id: KIMI_CODING_DEFAULT_MODEL_ID,
        name: "Kimi for Coding",
        reasoning: true,
        input: ["text", "image"],
        cost: KIMI_CODING_DEFAULT_COST,
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

function buildQwenPortalProvider(): ProviderConfig {
  return {
    baseUrl: QWEN_PORTAL_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "coder-model",
        name: "Qwen Coder",
        reasoning: false,
        input: ["text"],
        cost: QWEN_PORTAL_DEFAULT_COST,
        contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
        maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS,
      },
      {
        id: "vision-model",
        name: "Qwen Vision",
        reasoning: false,
        input: ["text", "image"],
        cost: QWEN_PORTAL_DEFAULT_COST,
        contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
        maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

function buildSyntheticProvider(): ProviderConfig {
  return {
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
  };
}

function buildDoubaoProvider(): ProviderConfig {
  return {
    baseUrl: DOUBAO_BASE_URL,
    api: "openai-completions",
    models: DOUBAO_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  };
}

function buildDoubaoCodingProvider(): ProviderConfig {
  return {
    baseUrl: DOUBAO_CODING_BASE_URL,
    api: "openai-completions",
    models: DOUBAO_CODING_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  };
}

function buildBytePlusProvider(): ProviderConfig {
  return {
    baseUrl: BYTEPLUS_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  };
}

function buildBytePlusCodingProvider(): ProviderConfig {
  return {
    baseUrl: BYTEPLUS_CODING_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_CODING_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  };
}

export function buildXiaomiProvider(): ProviderConfig {
  return {
    baseUrl: XIAOMI_BASE_URL,
    api: "anthropic-messages",
    models: [
      {
        id: XIAOMI_DEFAULT_MODEL_ID,
        name: "Xiaomi MiMo V2 Flash",
        reasoning: false,
        input: ["text"],
        cost: XIAOMI_DEFAULT_COST,
        contextWindow: XIAOMI_DEFAULT_CONTEXT_WINDOW,
        maxTokens: XIAOMI_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

async function buildVeniceProvider(): Promise<ProviderConfig> {
  const models = await discoverVeniceModels();
  return {
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    models,
  };
}

async function buildOllamaProvider(
  configuredBaseUrl?: string,
  opts?: { quiet?: boolean },
): Promise<ProviderConfig> {
  const models = await discoverOllamaModels(configuredBaseUrl, opts);
  return {
    baseUrl: resolveOllamaApiBase(configuredBaseUrl),
    api: "ollama",
    models,
  };
}

async function buildHuggingfaceProvider(apiKey?: string): Promise<ProviderConfig> {
  // Resolve env var name to value for discovery (GET /v1/models requires Bearer token).
  const resolvedSecret =
    apiKey?.trim() !== ""
      ? /^[A-Z][A-Z0-9_]*$/.test(apiKey!.trim())
        ? (process.env[apiKey!.trim()] ?? "").trim()
        : apiKey!.trim()
      : "";
  const models =
    resolvedSecret !== ""
      ? await discoverHuggingfaceModels(resolvedSecret)
      : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  return {
    baseUrl: HUGGINGFACE_BASE_URL,
    api: "openai-completions",
    models,
  };
}

function buildTogetherProvider(): ProviderConfig {
  return {
    baseUrl: TOGETHER_BASE_URL,
    api: "openai-completions",
    models: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
  };
}

function buildOpenrouterProvider(): ProviderConfig {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: OPENROUTER_DEFAULT_MODEL_ID,
        name: "OpenRouter Auto",
        // reasoning: false here is a catalog default only; it does NOT cause
        // `reasoning.effort: "none"` to be sent for the "auto" routing model.
        // applyExtraParamsToAgent skips the reasoning effort injection for
        // model id "auto" because it dynamically routes to any OpenRouter model
        // (including ones where reasoning is mandatory and cannot be disabled).
        // See: openclaw/openclaw#24851
        reasoning: false,
        input: ["text", "image"],
        cost: OPENROUTER_DEFAULT_COST,
        contextWindow: OPENROUTER_DEFAULT_CONTEXT_WINDOW,
        maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

async function buildVllmProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || VLLM_BASE_URL).replace(/\/+$/, "");
  const models = await discoverVllmModels(baseUrl, params?.apiKey);
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}

export function buildQianfanProvider(): ProviderConfig {
  return {
    baseUrl: QIANFAN_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: QIANFAN_DEFAULT_MODEL_ID,
        name: "DEEPSEEK V3.2",
        reasoning: true,
        input: ["text"],
        cost: QIANFAN_DEFAULT_COST,
        contextWindow: QIANFAN_DEFAULT_CONTEXT_WINDOW,
        maxTokens: QIANFAN_DEFAULT_MAX_TOKENS,
      },
      {
        id: "ernie-5.0-thinking-preview",
        name: "ERNIE-5.0-Thinking-Preview",
        reasoning: true,
        input: ["text", "image"],
        cost: QIANFAN_DEFAULT_COST,
        contextWindow: 119000,
        maxTokens: 64000,
      },
    ],
  };
}

export function buildAipingProvider(): ProviderConfig {
  return {
    baseUrl: AIPING_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: AIPING_DEFAULT_MODEL_ID,
        name: "DeepSeek V3.2",
        reasoning: false,
        input: ["text"],
        cost: AIPING_DEFAULT_COST,
        contextWindow: AIPING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AIPING_DEFAULT_MAX_TOKENS,
      },
      {
        id: "Auto",
        name: "AIPing Auto",
        reasoning: false,
        input: ["text"],
        cost: AIPING_DEFAULT_COST,
        contextWindow: AIPING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AIPING_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export function buildNvidiaProvider(): ProviderConfig {
  return {
    baseUrl: NVIDIA_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: NVIDIA_DEFAULT_MODEL_ID,
        name: "NVIDIA Llama 3.1 Nemotron 70B Instruct",
        reasoning: false,
        input: ["text"],
        cost: NVIDIA_DEFAULT_COST,
        contextWindow: NVIDIA_DEFAULT_CONTEXT_WINDOW,
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
      },
      {
        id: "meta/llama-3.3-70b-instruct",
        name: "Meta Llama 3.3 70B Instruct",
        reasoning: false,
        input: ["text"],
        cost: NVIDIA_DEFAULT_COST,
        contextWindow: 131072,
        maxTokens: 4096,
      },
      {
        id: "nvidia/mistral-nemo-minitron-8b-8k-instruct",
        name: "NVIDIA Mistral NeMo Minitron 8B Instruct",
        reasoning: false,
        input: ["text"],
        cost: NVIDIA_DEFAULT_COST,
        contextWindow: 8192,
        maxTokens: 2048,
      },
    ],
  };
}

export function buildKilocodeProvider(): ProviderConfig {
  return {
    baseUrl: KILOCODE_BASE_URL,
    api: "openai-completions",
    models: KILOCODE_MODEL_CATALOG.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: KILOCODE_DEFAULT_COST,
      contextWindow: model.contextWindow ?? KILOCODE_DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? KILOCODE_DEFAULT_MAX_TOKENS,
    })),
  };
}

export async function resolveImplicitProviders(params: {
  agentDir: string;
  explicitProviders?: Record<string, ProviderConfig> | null;
}): Promise<ModelsConfig["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });

  const minimaxKey =
    resolveEnvApiKeyVarName("minimax") ??
    resolveApiKeyFromProfiles({ provider: "minimax", store: authStore })?.apiKey;
  if (minimaxKey) {
    providers.minimax = { ...buildMinimaxProvider(), apiKey: minimaxKey };
  }

  const minimaxOauthProfile = listProfilesForProvider(authStore, "minimax-portal");
  if (minimaxOauthProfile.length > 0) {
    providers["minimax-portal"] = {
      ...buildMinimaxPortalProvider(),
      apiKey: MINIMAX_OAUTH_PLACEHOLDER,
    };
  }

  const moonshotKey =
    resolveEnvApiKeyVarName("moonshot") ??
    resolveApiKeyFromProfiles({ provider: "moonshot", store: authStore })?.apiKey;
  if (moonshotKey) {
    providers.moonshot = { ...buildMoonshotProvider(), apiKey: moonshotKey };
  }

  const kimiCodingKey =
    resolveEnvApiKeyVarName("kimi-coding") ??
    resolveApiKeyFromProfiles({ provider: "kimi-coding", store: authStore })?.apiKey;
  if (kimiCodingKey) {
    providers["kimi-coding"] = { ...buildKimiCodingProvider(), apiKey: kimiCodingKey };
  }

  const syntheticKey =
    resolveEnvApiKeyVarName("synthetic") ??
    resolveApiKeyFromProfiles({ provider: "synthetic", store: authStore })?.apiKey;
  if (syntheticKey) {
    providers.synthetic = { ...buildSyntheticProvider(), apiKey: syntheticKey };
  }

  const veniceKey =
    resolveEnvApiKeyVarName("venice") ??
    resolveApiKeyFromProfiles({ provider: "venice", store: authStore })?.apiKey;
  if (veniceKey) {
    providers.venice = { ...(await buildVeniceProvider()), apiKey: veniceKey };
  }

  const qwenProfiles = listProfilesForProvider(authStore, "qwen-portal");
  if (qwenProfiles.length > 0) {
    providers["qwen-portal"] = {
      ...buildQwenPortalProvider(),
      apiKey: QWEN_PORTAL_OAUTH_PLACEHOLDER,
    };
  }

  const volcengineKey =
    resolveEnvApiKeyVarName("volcengine") ??
    resolveApiKeyFromProfiles({ provider: "volcengine", store: authStore })?.apiKey;
  if (volcengineKey) {
    providers.volcengine = { ...buildDoubaoProvider(), apiKey: volcengineKey };
    providers["volcengine-plan"] = {
      ...buildDoubaoCodingProvider(),
      apiKey: volcengineKey,
    };
  }

  const byteplusKey =
    resolveEnvApiKeyVarName("byteplus") ??
    resolveApiKeyFromProfiles({ provider: "byteplus", store: authStore })?.apiKey;
  if (byteplusKey) {
    providers.byteplus = { ...buildBytePlusProvider(), apiKey: byteplusKey };
    providers["byteplus-plan"] = {
      ...buildBytePlusCodingProvider(),
      apiKey: byteplusKey,
    };
  }

  const xiaomiKey =
    resolveEnvApiKeyVarName("xiaomi") ??
    resolveApiKeyFromProfiles({ provider: "xiaomi", store: authStore })?.apiKey;
  if (xiaomiKey) {
    providers.xiaomi = { ...buildXiaomiProvider(), apiKey: xiaomiKey };
  }

  const cloudflareProfiles = listProfilesForProvider(authStore, "cloudflare-ai-gateway");
  for (const profileId of cloudflareProfiles) {
    const cred = authStore.profiles[profileId];
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
    const apiKey = resolveEnvApiKeyVarName("cloudflare-ai-gateway") ?? cred.key?.trim() ?? "";
    if (!apiKey) {
      continue;
    }
    providers["cloudflare-ai-gateway"] = {
      baseUrl,
      api: "anthropic-messages",
      apiKey,
      models: [buildCloudflareAiGatewayModelDefinition()],
    };
    break;
  }

  // Ollama provider - auto-discover if running locally, or add if explicitly configured.
  // Use the user's configured baseUrl (from explicit providers) for model
  // discovery so that remote / non-default Ollama instances are reachable.
  // Skip discovery when explicit models are already defined.
  const ollamaKey =
    resolveEnvApiKeyVarName("ollama") ??
    resolveApiKeyFromProfiles({ provider: "ollama", store: authStore })?.apiKey;
  const explicitOllama = params.explicitProviders?.ollama;
  const hasExplicitModels =
    Array.isArray(explicitOllama?.models) && explicitOllama.models.length > 0;
  if (hasExplicitModels && explicitOllama) {
    providers.ollama = {
      ...explicitOllama,
      baseUrl: resolveOllamaApiBase(explicitOllama.baseUrl),
      api: explicitOllama.api ?? "ollama",
      apiKey: ollamaKey ?? explicitOllama.apiKey ?? "ollama-local",
    };
  } else {
    const ollamaBaseUrl = explicitOllama?.baseUrl;
    const hasExplicitOllamaConfig = Boolean(explicitOllama);
    // Only suppress warnings for implicit local probing when user has not
    // explicitly configured Ollama.
    const ollamaProvider = await buildOllamaProvider(ollamaBaseUrl, {
      quiet: !ollamaKey && !hasExplicitOllamaConfig,
    });
    if (ollamaProvider.models.length > 0 || ollamaKey || explicitOllama?.apiKey) {
      providers.ollama = {
        ...ollamaProvider,
        apiKey: ollamaKey ?? explicitOllama?.apiKey ?? "ollama-local",
      };
    }
  }

  // vLLM provider - OpenAI-compatible local server (opt-in via env/profile).
  // If explicitly configured, keep user-defined models/settings as-is.
  if (!params.explicitProviders?.vllm) {
    const vllmEnvVar = resolveEnvApiKeyVarName("vllm");
    const vllmProfileKey = resolveApiKeyFromProfiles({
      provider: "vllm",
      store: authStore,
    })?.apiKey;
    const vllmKey = vllmEnvVar ?? vllmProfileKey;
    if (vllmKey) {
      const discoveryApiKey = vllmEnvVar
        ? (process.env[vllmEnvVar]?.trim() ?? "")
        : (vllmProfileKey ?? "");
      providers.vllm = {
        ...(await buildVllmProvider({ apiKey: discoveryApiKey || undefined })),
        apiKey: vllmKey,
      };
    }
  }

  const togetherKey =
    resolveEnvApiKeyVarName("together") ??
    resolveApiKeyFromProfiles({ provider: "together", store: authStore })?.apiKey;
  if (togetherKey) {
    providers.together = {
      ...buildTogetherProvider(),
      apiKey: togetherKey,
    };
  }

  const huggingfaceKey =
    resolveEnvApiKeyVarName("huggingface") ??
    resolveApiKeyFromProfiles({ provider: "huggingface", store: authStore })?.apiKey;
  if (huggingfaceKey) {
    const hfProvider = await buildHuggingfaceProvider(huggingfaceKey);
    providers.huggingface = {
      ...hfProvider,
      apiKey: huggingfaceKey,
    };
  }

  const qianfanKey =
    resolveEnvApiKeyVarName("qianfan") ??
    resolveApiKeyFromProfiles({ provider: "qianfan", store: authStore })?.apiKey;
  if (qianfanKey) {
    providers.qianfan = { ...buildQianfanProvider(), apiKey: qianfanKey };
  }

  const aipingKey =
    resolveEnvApiKeyVarName("aiping") ??
    resolveApiKeyFromProfiles({ provider: "aiping", store: authStore })?.apiKey;
  if (aipingKey) {
    providers.aiping = { ...buildAipingProvider(), apiKey: aipingKey };
  }

  const openrouterKey =
    resolveEnvApiKeyVarName("openrouter") ??
    resolveApiKeyFromProfiles({ provider: "openrouter", store: authStore })?.apiKey;
  if (openrouterKey) {
    providers.openrouter = { ...buildOpenrouterProvider(), apiKey: openrouterKey };
  }

  const nvidiaKey =
    resolveEnvApiKeyVarName("nvidia") ??
    resolveApiKeyFromProfiles({ provider: "nvidia", store: authStore })?.apiKey;
  if (nvidiaKey) {
    providers.nvidia = { ...buildNvidiaProvider(), apiKey: nvidiaKey };
  }

  const kilocodeKey =
    resolveEnvApiKeyVarName("kilocode") ??
    resolveApiKeyFromProfiles({ provider: "kilocode", store: authStore })?.apiKey;
  if (kilocodeKey) {
    providers.kilocode = { ...buildKilocodeProvider(), apiKey: kilocodeKey };
  }

  return providers;
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

  return providers;
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
