import type { BotConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_COPILOT_API_BASE_URL,
  resolveCopilotApiToken,
} from "../providers/github-copilot-token.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { discoverBedrockModels } from "./bedrock-discovery.js";
import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "./cloudflare-ai-gateway.js";
import {
  discoverHuggingfaceModels,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
  buildHuggingfaceModelDefinition,
} from "./huggingface-models.js";
import { resolveAwsSdkEnvVarName, resolveEnvApiKey } from "./model-auth.js";
import { OLLAMA_NATIVE_BASE_URL } from "./ollama-stream.js";
import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_MODEL_CATALOG,
} from "./synthetic-models.js";
import {
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
  buildTogetherModelDefinition,
} from "./together-models.js";
import { discoverVeniceModels, VENICE_BASE_URL } from "./venice-models.js";

type ModelsConfig = NonNullable<BotConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.1";
const MINIMAX_DEFAULT_VISION_MODEL_ID = "MiniMax-VL-01";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 200000;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
const MINIMAX_OAUTH_PLACEHOLDER = "minimax-oauth";
// Pricing: MiniMax doesn't publish public rates. Override in models.json for accurate costs.
const MINIMAX_API_COST = {
  input: 15,
  output: 60,
  cacheRead: 2,
  cacheWrite: 10,
};

type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[number];

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

const VLLM_BASE_URL = "http://127.0.0.1:8000/v1";
const VLLM_DEFAULT_CONTEXT_WINDOW = 128000;
const VLLM_DEFAULT_MAX_TOKENS = 8192;
const VLLM_DEFAULT_COST = {
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

const log = createSubsystemLogger("agents/model-providers");

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
      if (!opts?.quiet) console.warn("No Ollama models found on local instance");
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
      console.warn(`Failed to discover vLLM models: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as VllmModelsResponse;
    const models = data.data ?? [];
    if (models.length === 0) {
      console.warn("No vLLM models found on local instance");
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
    console.warn(`Failed to discover vLLM models: ${String(error)}`);
    return [];
  }
}

function normalizeApiKeyConfig(value: string): string {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function resolveEnvApiKeyVarName(provider: string): string | undefined {
  const resolved = resolveEnvApiKey(provider);
  if (!resolved) {
    return undefined;
  }
  const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
  return match ? match[1] : undefined;
}

function resolveAwsSdkApiKeyVarName(): string {
  return resolveAwsSdkEnvVarName() ?? "AWS_PROFILE";
}

function resolveApiKeyFromProfiles(params: {
  provider: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): string | undefined {
  const ids = listProfilesForProvider(params.store, params.provider);
  for (const id of ids) {
    const cred = params.store.profiles[id];
    if (!cred) {
      continue;
    }
    if (cred.type === "api_key") {
      return cred.key;
    }
    if (cred.type === "token") {
      return cred.token;
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
  return id;
}

function normalizeGoogleProvider(provider: ProviderConfig): ProviderConfig {
  let mutated = false;
  const models = provider.models.map((model) => {
    const nextId = normalizeGoogleModelId(model.id);
    if (nextId === model.id) {
      return model;
    }
    mutated = true;
    return { ...model, id: nextId };
  });
  return mutated ? { ...provider, models } : provider;
}

export function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    let normalizedProvider = provider;

    // Fix common misconfig: apiKey set to "${ENV_VAR}" instead of "ENV_VAR".
    // Only applies to plain-string apiKey values (not SecretRef objects).
    if (
      typeof normalizedProvider.apiKey === "string" &&
      normalizeApiKeyConfig(normalizedProvider.apiKey) !== normalizedProvider.apiKey
    ) {
      mutated = true;
      normalizedProvider = {
        ...normalizedProvider,
        apiKey: normalizeApiKeyConfig(normalizedProvider.apiKey),
      };
    }

    // If a provider defines models, pi's ModelRegistry requires apiKey to be set.
    // Fill it from the environment or auth profiles when possible.
    const hasModels =
      Array.isArray(normalizedProvider.models) && normalizedProvider.models.length > 0;
    const apiKeyStr =
      typeof normalizedProvider.apiKey === "string" ? normalizedProvider.apiKey : undefined;
    if (hasModels && !apiKeyStr?.trim()) {
      const authMode =
        normalizedProvider.auth ?? (normalizedKey === "amazon-bedrock" ? "aws-sdk" : undefined);
      if (authMode === "aws-sdk") {
        const apiKey = resolveAwsSdkApiKeyVarName();
        mutated = true;
        normalizedProvider = { ...normalizedProvider, apiKey };
      } else {
        const fromEnv = resolveEnvApiKeyVarName(normalizedKey);
        const fromProfiles = resolveApiKeyFromProfiles({
          provider: normalizedKey,
          store: authStore,
        });
        const apiKey = fromEnv ?? fromProfiles;
        if (apiKey?.trim()) {
          mutated = true;
          normalizedProvider = { ...normalizedProvider, apiKey };
        }
      }
    }

    if (normalizedKey === "google") {
      const googleNormalized = normalizeGoogleProvider(normalizedProvider);
      if (googleNormalized !== normalizedProvider) {
        mutated = true;
      }
      normalizedProvider = googleNormalized;
    }

    next[key] = normalizedProvider;
  }

  return mutated ? next : providers;
}

function buildMinimaxProvider(): ProviderConfig {
  return {
    baseUrl: MINIMAX_PORTAL_BASE_URL,
    api: "anthropic-messages",
    models: [
      buildMinimaxTextModel({
        id: MINIMAX_DEFAULT_MODEL_ID,
        name: "MiniMax M2.1",
        reasoning: false,
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.1-lightning",
        name: "MiniMax M2.1 Lightning",
        reasoning: false,
      }),
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
    models: [
      buildMinimaxTextModel({
        id: MINIMAX_DEFAULT_MODEL_ID,
        name: "MiniMax M2.1",
        reasoning: false,
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5",
        name: "MiniMax M2.5",
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
        input: ["text"],
        cost: MOONSHOT_DEFAULT_COST,
        contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
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

// ---------------------------------------------------------------------------
// Hanzo Cloud — routes through api.hanzo.ai with IAM JWT auth
// ---------------------------------------------------------------------------

const HANZO_API_BASE_URL = "https://api.hanzo.ai/v1";

/** Build the Hanzo Cloud provider with Zen3/Zen4 + third-party models via api.hanzo.ai gateway. */
export function buildHanzoCloudProvider(): ProviderConfig {
  return {
    baseUrl: HANZO_API_BASE_URL,
    api: "openai-completions",
    models: [
      // -----------------------------------------------------------------------
      // Zen4 — Latest generation (flagship)
      // -----------------------------------------------------------------------
      {
        id: "zen4",
        name: "Zen4 Flagship",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 9.6, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 202000,
        maxTokens: 16384,
      },
      {
        id: "zen4-pro",
        name: "Zen4 Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2.7, output: 2.7, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131000,
        maxTokens: 16384,
      },
      {
        id: "zen4-max",
        name: "Zen4 Max",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3.6, output: 3.6, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131000,
        maxTokens: 16384,
      },
      {
        id: "zen4-mini",
        name: "Zen4 Mini",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.6, output: 0.6, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 40000,
        maxTokens: 8192,
      },
      {
        id: "zen4-ultra",
        name: "Zen4 Ultra",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 9.6, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 202000,
        maxTokens: 16384,
      },
      {
        id: "zen4-thinking",
        name: "Zen4 Thinking",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2.7, output: 2.7, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131000,
        maxTokens: 16384,
      },
      // -----------------------------------------------------------------------
      // Zen4 — Coder variants
      // -----------------------------------------------------------------------
      {
        id: "zen4-coder",
        name: "Zen4 Coder",
        reasoning: true,
        input: ["text"],
        cost: { input: 3.6, output: 3.6, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262000,
        maxTokens: 16384,
      },
      {
        id: "zen4-coder-flash",
        name: "Zen4 Coder Flash",
        reasoning: true,
        input: ["text"],
        cost: { input: 1.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262000,
        maxTokens: 16384,
      },
      {
        id: "zen4-coder-pro",
        name: "Zen4 Coder Pro",
        reasoning: true,
        input: ["text"],
        cost: { input: 4.5, output: 4.5, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262000,
        maxTokens: 16384,
      },
      // -----------------------------------------------------------------------
      // Zen3 — Multimodal / specialty
      // -----------------------------------------------------------------------
      {
        id: "zen3-omni",
        name: "Zen3 Omni",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.8, output: 6.6, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 202000,
        maxTokens: 16384,
      },
      {
        id: "zen3-vl",
        name: "Zen3 VL",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.45, output: 1.8, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131000,
        maxTokens: 8192,
      },
      {
        id: "zen3-nano",
        name: "Zen3 Nano",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.3, output: 0.3, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 40000,
        maxTokens: 4096,
      },
      // -----------------------------------------------------------------------
      // Third-party models (via Hanzo gateway — unified billing)
      // -----------------------------------------------------------------------
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 },
        contextWindow: 1000000,
        maxTokens: 32000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3.6, output: 18, cacheRead: 0.36, cacheWrite: 4.5 },
        contextWindow: 1000000,
        maxTokens: 16384,
      },
      {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 1.2, output: 6, cacheRead: 0.12, cacheWrite: 1.5 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.5, output: 12, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 16384,
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.3, output: 2.4, cacheRead: 0.03, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 16384,
      },
    ],
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
    resolveApiKeyFromProfiles({ provider: "minimax", store: authStore });
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
    resolveApiKeyFromProfiles({ provider: "moonshot", store: authStore });
  if (moonshotKey) {
    providers.moonshot = { ...buildMoonshotProvider(), apiKey: moonshotKey };
  }

  const syntheticKey =
    resolveEnvApiKeyVarName("synthetic") ??
    resolveApiKeyFromProfiles({ provider: "synthetic", store: authStore });
  if (syntheticKey) {
    providers.synthetic = { ...buildSyntheticProvider(), apiKey: syntheticKey };
  }

  const veniceKey =
    resolveEnvApiKeyVarName("venice") ??
    resolveApiKeyFromProfiles({ provider: "venice", store: authStore });
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

  const xiaomiKey =
    resolveEnvApiKeyVarName("xiaomi") ??
    resolveApiKeyFromProfiles({ provider: "xiaomi", store: authStore });
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
    resolveApiKeyFromProfiles({ provider: "ollama", store: authStore });
  const explicitOllama = params.explicitProviders?.ollama;
  const hasExplicitModels =
    Array.isArray(explicitOllama?.models) && explicitOllama.models.length > 0;
  if (hasExplicitModels) {
    providers.ollama = {
      ...explicitOllama,
      api: explicitOllama.api ?? "ollama",
      apiKey: ollamaKey ?? "ollama-local",
    };
  } else {
    const ollamaBaseUrl = explicitOllama?.baseUrl;
    const hasExplicitOllamaConfig = Boolean(explicitOllama);
    // Only suppress warnings for implicit local probing when user has not
    // explicitly configured Ollama.
    const ollamaProvider = await buildOllamaProvider(ollamaBaseUrl, {
      quiet: !ollamaKey && !hasExplicitOllamaConfig,
    });
    if (ollamaProvider.models.length > 0 || ollamaKey) {
      providers.ollama = {
        ...ollamaProvider,
        apiKey: ollamaKey ?? "ollama-local",
      };
    }
  }

  // vLLM provider - OpenAI-compatible local server (opt-in via env/profile).
  // If explicitly configured, keep user-defined models/settings as-is.
  if (!params.explicitProviders?.vllm) {
    const vllmEnvVar = resolveEnvApiKeyVarName("vllm");
    const vllmProfileKey = resolveApiKeyFromProfiles({ provider: "vllm", store: authStore });
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
    resolveApiKeyFromProfiles({ provider: "together", store: authStore });
  if (togetherKey) {
    providers.together = {
      ...buildTogetherProvider(),
      apiKey: togetherKey,
    };
  }

  const huggingfaceKey =
    resolveEnvApiKeyVarName("huggingface") ??
    resolveApiKeyFromProfiles({ provider: "huggingface", store: authStore });
  if (huggingfaceKey) {
    const hfProvider = await buildHuggingfaceProvider(huggingfaceKey);
    providers.huggingface = {
      ...hfProvider,
      apiKey: huggingfaceKey,
    };
  }

  const qianfanKey =
    resolveEnvApiKeyVarName("qianfan") ??
    resolveApiKeyFromProfiles({ provider: "qianfan", store: authStore });
  if (qianfanKey) {
    providers.qianfan = { ...buildQianfanProvider(), apiKey: qianfanKey };
  }

  const nvidiaKey =
    resolveEnvApiKeyVarName("nvidia") ??
    resolveApiKeyFromProfiles({ provider: "nvidia", store: authStore });
  if (nvidiaKey) {
    providers.nvidia = { ...buildNvidiaProvider(), apiKey: nvidiaKey };
  }

  // Hanzo Cloud provider — routes through api.hanzo.ai with IAM JWT auth.
  // Auto-registers when HANZO_API_KEY is set (via IAM OAuth) or hanzo-iam profile exists.
  const hanzoKey =
    resolveEnvApiKeyVarName("hanzo") ??
    resolveApiKeyFromProfiles({ provider: "hanzo-iam", store: authStore });
  if (hanzoKey) {
    providers.hanzo = { ...buildHanzoCloudProvider(), apiKey: hanzoKey };
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
      selectedGithubToken = profile.token;
    }
  }

  let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
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

  // pi-coding-agent's ModelRegistry marks a model "available" only if its
  // `AuthStorage` has auth configured for that provider (via auth.json/env/etc).
  // Our Copilot auth lives in Hanzo Bot's auth-profiles store instead, so we also
  // write a runtime-only auth.json entry for pi-coding-agent to pick up.
  //
  // This is safe because it's (1) within Hanzo Bot's agent dir, (2) contains the
  // GitHub token (not the exchanged Copilot token), and (3) matches existing
  // patterns for OAuth-like providers in pi-coding-agent.
  // Note: we deliberately do not write pi-coding-agent's `auth.json` here.
  // Hanzo Bot uses its own auth store and exchanges tokens at runtime.
  // `models list` uses Hanzo Bot's auth heuristics for availability.

  // We intentionally do NOT define custom models for Copilot in models.json.
  // pi-coding-agent treats providers with models as replacements requiring apiKey.
  // We only override baseUrl; the model list comes from pi-ai built-ins.
  return {
    baseUrl,
    models: [],
  } satisfies ProviderConfig;
}

export async function resolveImplicitBedrockProvider(params: {
  agentDir: string;
  config?: BotConfig;
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
