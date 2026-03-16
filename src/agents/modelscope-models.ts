import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("modelscope-models");

/** ModelScope Inference API — OpenAI-compatible chat completions. */
export const MODELSCOPE_BASE_URL = "https://api-inference.modelscope.cn/v1";

/**
 * ModelScope does not use policy suffixes like :cheapest or :fastest.
 * All model selection is direct without router-based cost/speed policies.
 */
export const MODELSCOPE_POLICY_SUFFIXES: readonly string[] = [];

/** Default cost — all ModelScope models are currently free. */
const MODELSCOPE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** Defaults for models discovered from GET /v1/models. */
const MODELSCOPE_DEFAULT_CONTEXT_WINDOW = 32768;
const MODELSCOPE_DEFAULT_MAX_TOKENS = 8192;

/**
 * Shape of a single model entry from GET https://api-inference.modelscope.cn/v1/models.
 * Response is OpenAI-style list with additional ModelScope-specific fields.
 */
interface ModelScopeModelEntry {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  /** Display name fields (not always present). */
  name?: string;
  title?: string;
  display_name?: string;
  /** Input modalities for multimodal support. */
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Response shape from GET /v1/models (OpenAI-style list). */
interface OpenAIListModelsResponse {
  object?: string;
  data?: ModelScopeModelEntry[];
}

/**
 * Static catalog for well-known models (optional, for better metadata).
 * You can expand this with context window or aliases if needed.
 */
export const MODELSCOPE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "Qwen/Qwen3-8B",
    name: "Qwen3 8B",
    reasoning: true,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
    cost: MODELSCOPE_DEFAULT_COST,
  },
  {
    id: "Qwen/Qwen3-32B",
    name: "Qwen3 32B",
    reasoning: true,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
    cost: MODELSCOPE_DEFAULT_COST,
  },
  {
    id: "Qwen/Qwen3.5-27B",
    name: "Qwen3.5 27B",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 66000,
    cost: MODELSCOPE_DEFAULT_COST,
  },
  {
    id: "Qwen/Qwen3.5-122B-A10B",
    name: "Qwen3.5 122B A100B",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 66000,
    cost: MODELSCOPE_DEFAULT_COST,
  },
];

export function buildModelScopeModelDefinition(
  model: (typeof MODELSCOPE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Infer display name and reasoning capability from model ID.
 */
function inferredMetaFromModelId(id: string): { name: string; reasoning: boolean } {
  const base = id.split("/").pop() ?? id;
  // Heuristic: models with "R1", "Thinking", "Reason" likely support reasoning
  const reasoning = /r1|reasoning|thinking|reason/i.test(id) || /-\d+[tb]?-thinking/i.test(base);
  // Convert kebab-case to Title Case
  const name = base.replace(/-/g, " ").replace(/\b(\w)/g, (char) => char.toUpperCase());
  return { name, reasoning };
}

/**
 * Prefer API-provided display name, fall back to inferred.
 */
function displayNameFromApiEntry(entry: ModelScopeModelEntry, inferredName: string): string {
  const fromApi =
    (typeof entry.name === "string" && entry.name.trim()) ||
    (typeof entry.title === "string" && entry.title.trim()) ||
    (typeof entry.display_name === "string" && entry.display_name.trim());
  return fromApi || inferredName;
}

/**
 * Discover models from ModelScope Inference API (GET /v1/models).
 * Uses the provided API key for authenticated discovery if available.
 */
export async function discoverModelScopeModels(apiKey: string): Promise<ModelDefinitionConfig[]> {
  // In test environments, return static catalog
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return MODELSCOPE_MODEL_CATALOG.map(buildModelScopeModelDefinition);
  }

  const trimmedKey = apiKey?.trim();
  try {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };

    if (trimmedKey) {
      headers["Authorization"] = `Bearer ${trimmedKey}`;
    }

    const response = await fetch(`${MODELSCOPE_BASE_URL}/models`, {
      signal: AbortSignal.timeout(10_000),
      headers,
    });

    if (!response.ok) {
      log.warn(`GET /v1/models failed: HTTP ${response.status}, using static catalog`);
      return MODELSCOPE_MODEL_CATALOG.map(buildModelScopeModelDefinition);
    }

    const body = (await response.json()) as OpenAIListModelsResponse;
    const data = body?.data;
    if (!Array.isArray(data) || data.length === 0) {
      log.warn("No models in response, using static catalog");
      return MODELSCOPE_MODEL_CATALOG.map(buildModelScopeModelDefinition);
    }

    const catalogById = new Map(MODELSCOPE_MODEL_CATALOG.map((m) => [m.id, m] as const));
    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of data) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);

      const catalogEntry = catalogById.get(id);
      if (catalogEntry) {
        models.push(buildModelScopeModelDefinition(catalogEntry));
      } else {
        const inferred = inferredMetaFromModelId(id);
        const name = displayNameFromApiEntry(entry, inferred.name);
        const modalities = entry.architecture?.input_modalities;
        const input: Array<"text" | "image"> =
          Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"];
        models.push({
          id,
          name,
          reasoning: inferred.reasoning,
          input,
          cost: MODELSCOPE_DEFAULT_COST,
          contextWindow: MODELSCOPE_DEFAULT_CONTEXT_WINDOW,
          maxTokens: MODELSCOPE_DEFAULT_MAX_TOKENS,
        });
      }
    }

    return models.length > 0
      ? models
      : MODELSCOPE_MODEL_CATALOG.map(buildModelScopeModelDefinition);
  } catch (error) {
    log.warn(`ModelScope model discovery failed: ${String(error)}, using static catalog`);
    return MODELSCOPE_MODEL_CATALOG.map(buildModelScopeModelDefinition);
  }
}
