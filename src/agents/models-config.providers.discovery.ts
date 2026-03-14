import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { KILOCODE_BASE_URL } from "../providers/kilocode-shared.js";
import {
  discoverHuggingfaceModels,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
  buildHuggingfaceModelDefinition,
} from "./huggingface-models.js";
import { discoverKilocodeModels } from "./kilocode-models.js";
import {
  enrichOllamaModelsWithContext,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
  isReasoningModelHeuristic,
  resolveOllamaApiBase,
  type OllamaTagsResponse,
} from "./ollama-models.js";
import { discoverVeniceModels, VENICE_BASE_URL } from "./venice-models.js";
import { discoverVercelAiGatewayModels, VERCEL_AI_GATEWAY_BASE_URL } from "./vercel-ai-gateway.js";

export { resolveOllamaApiBase } from "./ollama-models.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

const log = createSubsystemLogger("agents/model-providers");

const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_SHOW_MAX_MODELS = 200;

const OPENAI_COMPAT_LOCAL_DEFAULT_CONTEXT_WINDOW = 128000;
const OPENAI_COMPAT_LOCAL_DEFAULT_MAX_TOKENS = 8192;
const OPENAI_COMPAT_LOCAL_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const SGLANG_BASE_URL = "http://127.0.0.1:30000/v1";

const VLLM_BASE_URL = "http://127.0.0.1:8000/v1";

type OpenAICompatModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

async function discoverOllamaModels(
  baseUrl?: string,
  opts?: { quiet?: boolean },
): Promise<ModelDefinitionConfig[]> {
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
    const discovered = await enrichOllamaModelsWithContext(apiBase, modelsToInspect, {
      concurrency: OLLAMA_SHOW_CONCURRENCY,
    });
    return discovered.map((model) => ({
      id: model.name,
      name: model.name,
      reasoning: isReasoningModelHeuristic(model.name),
      input: ["text"],
      cost: OLLAMA_DEFAULT_COST,
      contextWindow: model.contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
      maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
    }));
  } catch (error) {
    if (!opts?.quiet) {
      log.warn(`Failed to discover Ollama models: ${String(error)}`);
    }
    return [];
  }
}

async function discoverOpenAICompatibleLocalModels(params: {
  baseUrl: string;
  apiKey?: string;
  label: string;
  contextWindow?: number;
  maxTokens?: number;
}): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }

  const trimmedBaseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  const url = `${trimmedBaseUrl}/models`;

  try {
    const trimmedApiKey = params.apiKey?.trim();
    const response = await fetch(url, {
      headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`Failed to discover ${params.label} models: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as OpenAICompatModelsResponse;
    const models = data.data ?? [];
    if (models.length === 0) {
      log.warn(`No ${params.label} models found on local instance`);
      return [];
    }

    return models
      .map((model) => ({ id: typeof model.id === "string" ? model.id.trim() : "" }))
      .filter((model) => Boolean(model.id))
      .map((model) => {
        const modelId = model.id;
        return {
          id: modelId,
          name: modelId,
          reasoning: isReasoningModelHeuristic(modelId),
          input: ["text"],
          cost: OPENAI_COMPAT_LOCAL_DEFAULT_COST,
          contextWindow: params.contextWindow ?? OPENAI_COMPAT_LOCAL_DEFAULT_CONTEXT_WINDOW,
          maxTokens: params.maxTokens ?? OPENAI_COMPAT_LOCAL_DEFAULT_MAX_TOKENS,
        } satisfies ModelDefinitionConfig;
      });
  } catch (error) {
    log.warn(`Failed to discover ${params.label} models: ${String(error)}`);
    return [];
  }
}

export async function buildVeniceProvider(): Promise<ProviderConfig> {
  const models = await discoverVeniceModels();
  return {
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    models,
  };
}

export async function buildOllamaProvider(
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

export async function buildHuggingfaceProvider(discoveryApiKey?: string): Promise<ProviderConfig> {
  const resolvedSecret = discoveryApiKey?.trim() ?? "";
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

export async function buildVercelAiGatewayProvider(): Promise<ProviderConfig> {
  return {
    baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    models: await discoverVercelAiGatewayModels(),
  };
}

export async function buildVllmProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || VLLM_BASE_URL).replace(/\/+$/, "");
  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    apiKey: params?.apiKey,
    label: "vLLM",
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}

export async function buildSglangProvider(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || SGLANG_BASE_URL).replace(/\/+$/, "");
  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    apiKey: params?.apiKey,
    label: "SGLang",
  });
  return {
    baseUrl,
    api: "openai-completions",
    models,
  };
}

/**
 * Build the Kilocode provider with dynamic model discovery from the gateway
 * API. Falls back to the static catalog on failure.
 * Pass apiKey so org-scoped discovery requests include an Authorization header.
 */
export async function buildKilocodeProviderWithDiscovery(apiKey?: string): Promise<ProviderConfig> {
  const models = await discoverKilocodeModels(apiKey);
  return {
    baseUrl: KILOCODE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
