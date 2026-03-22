import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  enrichOllamaModelsWithContext,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
  isReasoningModelHeuristic,
  resolveOllamaApiBase,
  type OllamaTagsResponse,
} from "./ollama-models.js";

export { resolveOllamaApiBase } from "./ollama-models.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

const log = createSubsystemLogger("agents/model-providers");

const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_SHOW_MAX_MODELS = 200;

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
      log.warn(`Failed to discover models: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as OpenAICompatModelsResponse;
    const models = data.data ?? [];
    if (models.length === 0) {
      log.warn(`No models found on local instance`);
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
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        } satisfies ModelDefinitionConfig;
      });
  } catch (error) {
    log.warn(`Failed to discover models: ${String(error)}`);
    return [];
  }
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

// Stub provider builders for backward compatibility - all use openai-completions
export function buildKilocodeProvider(): ProviderConfig {
  return {
    baseUrl: "https://kilocode.ai",
    api: "openai-completions",
    models: [{
      id: "kilo/claude-sonnet-4-5",
      name: "Kilo Claude Sonnet 4.5",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }],
  };
}

export function buildKimiCodingProvider(): ProviderConfig {
  return {
    baseUrl: "https://kimi.moonshot.cn",
    api: "openai-completions",
    models: [{
      id: "kimi-latest",
      name: "Kimi Latest",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }],
  };
}

export function buildQianfanProvider(): ProviderConfig {
  return {
    baseUrl: "https://qianfan.baidubce.com",
    api: "openai-completions",
    models: [{
      id: "ernie-bot-4",
      name: "ERNIE Bot 4",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }],
  };
}

export function buildXiaomiProvider(): ProviderConfig {
  return {
    baseUrl: "https://api.xiaomi.ai",
    api: "openai-completions",
    models: [{
      id: "mi-max",
      name: "Mi Max",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }],
  };
}

export const QIANFAN_DEFAULT_MODEL_ID = "ernie-bot-4";
export const XIAOMI_DEFAULT_MODEL_ID = "mi-max";
export const QIANFAN_BASE_URL = "https://qianfan.baidubce.com";

export function normalizeGoogleModelId(modelId: string): string {
  // Strip provider prefix if present (e.g., "google/" or "google-gemini-cli/")
  return modelId.replace(/^(google|google-gemini-cli)\//i, "");
}
