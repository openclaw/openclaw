/**
 * OpenCode Go model catalog with dynamic fetching, caching, and static fallback.
 *
 * OpenCode Go is a regional variant of OpenCode Zen that provides access to
 * a curated subset of models optimized for coding agents in specific markets.
 *
 * It is identical to OpenCode Zen except:
 * - API endpoint: https://opencode.ai/zen/go/v1 (instead of /zen/v1)
 * - Only supports: glm-5, minimax-m2.5, kimi-k2.5
 *
 * Auth URL: https://opencode.ai/auth
 */

import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("opencode-go-models");

export const OPENCODE_GO_API_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_GO_DEFAULT_MODEL = "minimax-m2.5";
export const OPENCODE_GO_DEFAULT_MODEL_REF = `opencode-go/${OPENCODE_GO_DEFAULT_MODEL}`;

// Cache for fetched models (1 hour TTL)
let cachedModels: ModelDefinitionConfig[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Model aliases for convenient shortcuts.
 * Users can use "glm" instead of "glm-5", etc.
 */
export const OPENCODE_GO_MODEL_ALIASES: Record<string, string> = {
  glm: "glm-5",
  "glm-5": "glm-5",
  minimax: "minimax-m2.5",
  "minimax-m2.5": "minimax-m2.5",
  kimi: "kimi-k2.5",
  "kimi-k2.5": "kimi-k2.5",
};

/**
 * Resolve a model alias to its full model ID.
 * Returns the input if no alias exists.
 */
export function resolveOpencodeGoAlias(modelIdOrAlias: string): string {
  const normalized = modelIdOrAlias.toLowerCase().trim();
  return OPENCODE_GO_MODEL_ALIASES[normalized] ?? modelIdOrAlias;
}

/**
 * OpenCode Go routes all models through OpenAI-compatible completions API.
 */
export function resolveOpencodeGoModelApi(_modelId: string): ModelApi {
  return "openai-completions";
}

/**
 * Check if a model supports image input.
 */
function supportsImageInput(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes("glm") || lower.includes("minimax")) {
    return false;
  }
  return true;
}

const MODEL_COSTS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "glm-5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "minimax-m2.5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "kimi-k2.5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "glm-5": 204800,
  "minimax-m2.5": 204800,
  "kimi-k2.5": 256000,
};

function getDefaultContextWindow(modelId: string): number {
  return MODEL_CONTEXT_WINDOWS[modelId] ?? 128000;
}

const MODEL_MAX_TOKENS: Record<string, number> = {
  "glm-5": 131072,
  "minimax-m2.5": 131072,
  "kimi-k2.5": 8192,
};

function getDefaultMaxTokens(modelId: string): number {
  return MODEL_MAX_TOKENS[modelId] ?? 8192;
}

/**
 * Build a ModelDefinitionConfig from a model ID.
 */
function buildModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: formatModelName(modelId),
    api: resolveOpencodeGoModelApi(modelId),
    // Treat Go models as reasoning-capable so defaults pick thinkLevel="low" unless users opt out.
    reasoning: true,
    input: supportsImageInput(modelId) ? ["text", "image"] : ["text"],
    cost: MODEL_COSTS[modelId] ?? DEFAULT_COST,
    contextWindow: getDefaultContextWindow(modelId),
    maxTokens: getDefaultMaxTokens(modelId),
  };
}

/**
 * Format a model ID into a human-readable name.
 */
const MODEL_NAMES: Record<string, string> = {
  "glm-5": "GLM-5",
  "minimax-m2.5": "MiniMax M2.5",
  "kimi-k2.5": "Kimi K2.5",
};

function formatModelName(modelId: string): string {
  if (MODEL_NAMES[modelId]) {
    return MODEL_NAMES[modelId];
  }

  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Static fallback models when API is unreachable.
 */
export function getOpencodeGoStaticFallbackModels(): ModelDefinitionConfig[] {
  const modelIds = ["glm-5", "minimax-m2.5", "kimi-k2.5"];

  return modelIds.map(buildModelDefinition);
}

/**
 * Response shape from OpenCode Go /models endpoint.
 * Returns OpenAI-compatible format.
 */
interface GoModelsResponse {
  data: Array<{
    id: string;
    object: "model";
    created?: number;
    owned_by?: string;
  }>;
}

/**
 * Fetch models from the OpenCode Go API.
 * Uses caching with 1-hour TTL.
 *
 * @param apiKey - OpenCode Go API key for authentication
 * @returns Array of model definitions, or static fallback on failure
 */
export async function fetchOpencodeGoModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  // Return cached models if still valid
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${OPENCODE_GO_API_BASE_URL}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as GoModelsResponse;

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from /models endpoint");
    }

    const models = data.data.map((model) => buildModelDefinition(model.id));

    cachedModels = models;
    cacheTimestamp = now;

    return models;
  } catch (error) {
    log.warn(`Failed to fetch models, using static fallback: ${String(error)}`);
    return getOpencodeGoStaticFallbackModels();
  }
}

/**
 * Clear the model cache (useful for testing or forcing refresh).
 */
export function clearOpencodeGoModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}
