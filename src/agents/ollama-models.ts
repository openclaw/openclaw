import type { ModelDefinitionConfig } from "../config/types.models.js";
import { OLLAMA_DEFAULT_BASE_URL } from "./ollama-defaults.js";

export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
export const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
export const OLLAMA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export type OllamaTagModel = {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  remote_host?: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
};

export type OllamaTagsResponse = {
  models?: OllamaTagModel[];
};

export type OllamaModelMetadata = {
  contextWindow?: number;
  supportsVision?: boolean;
  parameterSize?: string;
  quantizationLevel?: string;
  modelFamily?: string;
};

export type OllamaModelWithContext = OllamaTagModel & OllamaModelMetadata;

export const OLLAMA_SHOW_CONCURRENCY = 8;

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
    return OLLAMA_DEFAULT_BASE_URL;
  }
  const trimmed = configuredBaseUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

type OllamaShowResponse = {
  model_info?: Record<string, unknown>;
  details?: {
    families?: string[];
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
  projectors?: string[];
};

function detectVisionFromShowResponse(data: OllamaShowResponse): boolean {
  if (data.projectors && data.projectors.length > 0) {
    return true;
  }
  if (data.details?.families?.some((f) => /clip|vision/i.test(f))) {
    return true;
  }
  if (data.model_info) {
    for (const key of Object.keys(data.model_info)) {
      if (/clip\.|vision_encoder|vision_tower|mmproj/i.test(key)) {
        return true;
      }
    }
  }
  return false;
}

export async function queryOllamaModelMetadata(
  apiBase: string,
  modelName: string,
): Promise<OllamaModelMetadata> {
  try {
    const response = await fetch(`${apiBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return {};
    }
    const data = (await response.json()) as OllamaShowResponse;
    const result: OllamaModelMetadata = {};
    if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (
          key.endsWith(".context_length") &&
          typeof value === "number" &&
          Number.isFinite(value)
        ) {
          const contextWindow = Math.floor(value);
          if (contextWindow > 0) {
            result.contextWindow = contextWindow;
            break;
          }
        }
      }
    }
    result.supportsVision = detectVisionFromShowResponse(data);
    if (data.details?.parameter_size) {
      result.parameterSize = data.details.parameter_size;
    } else if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (
          key.endsWith(".parameter_count") &&
          typeof value === "number" &&
          value > 0
        ) {
          const billions = value / 1e9;
          result.parameterSize =
            billions >= 1 ? `${billions.toFixed(1)}B` : `${(value / 1e6).toFixed(0)}M`;
          break;
        }
      }
    }
    if (data.details?.quantization_level) {
      result.quantizationLevel = data.details.quantization_level;
    }
    if (data.details?.family) {
      result.modelFamily = data.details.family;
    } else if (data.model_info) {
      const arch = data.model_info["general.architecture"];
      if (typeof arch === "string") {
        result.modelFamily = arch;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  const metadata = await queryOllamaModelMetadata(apiBase, modelName);
  return metadata.contextWindow;
}

export async function enrichOllamaModelsWithContext(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: { concurrency?: number },
): Promise<OllamaModelWithContext[]> {
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += concurrency) {
    const batch = models.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const metadata = await queryOllamaModelMetadata(apiBase, model.name);
        return {
          ...model,
          contextWindow: metadata.contextWindow,
          supportsVision: metadata.supportsVision,
          parameterSize: metadata.parameterSize ?? model.details?.parameter_size,
          quantizationLevel: metadata.quantizationLevel ?? model.details?.quantization_level,
          modelFamily: metadata.modelFamily ?? model.details?.family,
        };
      }),
    );
    enriched.push(...batchResults);
  }
  return enriched;
}

/** Heuristic: treat models with reasoning-related keywords in the name as reasoning models. */
export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason|qwq|o1[^a-z]/i.test(modelId);
}

/** Heuristic: treat models with vision-related keywords in the name as vision models. */
export function isVisionModelHeuristic(modelId: string): boolean {
  return /vision|llava|bakllava|moondream|minicpm-v|cogvlm|internvl|glm-4v/i.test(modelId);
}

/** Build a ModelDefinitionConfig for an Ollama model with default values. */
export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
  supportsVision?: boolean,
): ModelDefinitionConfig {
  const vision = supportsVision ?? isVisionModelHeuristic(modelId);
  return {
    id: modelId,
    name: modelId,
    reasoning: isReasoningModelHeuristic(modelId),
    input: vision ? ["text", "image"] : ["text"],
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
  };
}

/** Fetch the Ollama server version from /api/version. */
export async function queryOllamaVersion(
  apiBase: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${apiBase}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch the model list from a running Ollama instance. */
export async function fetchOllamaModels(
  baseUrl: string,
): Promise<{ reachable: boolean; models: OllamaTagModel[] }> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const response = await fetch(`${apiBase}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { reachable: true, models: [] };
    }
    const data = (await response.json()) as OllamaTagsResponse;
    const models = (data.models ?? []).filter((m) => m.name);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}
