/**
 * OpenCode Zen model catalog with dynamic fetching, caching, and static fallback.
 *
 * OpenCode Zen is a $200/month subscription that provides proxy access to multiple
 * AI models (Claude, GPT, Gemini, etc.) through a single API endpoint.
 *
 * API endpoint: https://opencode.ai/zen/v1
 * Auth URL: https://opencode.ai/auth
 */

import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";

export const OPENCODE_ZEN_API_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_ZEN_DEFAULT_MODEL = "claude-opus-4-5";
export const OPENCODE_ZEN_DEFAULT_MODEL_REF = `opencode-zen/${OPENCODE_ZEN_DEFAULT_MODEL}`;

// Cache for fetched models (1 hour TTL)
let cachedModels: ModelDefinitionConfig[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Model aliases for convenient shortcuts.
 * Users can use "opus" instead of "claude-opus-4-5", etc.
 */
export const OPENCODE_ZEN_MODEL_ALIASES: Record<string, string> = {
  // Claude aliases
  opus: "claude-opus-4-5",
  "opus-4.5": "claude-opus-4-5",
  "opus-4": "claude-opus-4-5",
  sonnet: "claude-sonnet-4-20250514",
  "sonnet-4": "claude-sonnet-4-20250514",
  haiku: "claude-haiku-3-5-20241022",
  "haiku-3.5": "claude-haiku-3-5-20241022",

  // GPT aliases
  gpt5: "gpt-5.2",
  "gpt-5": "gpt-5.2",
  gpt4: "gpt-4.1",
  "gpt-4": "gpt-4.1",
  "gpt-mini": "gpt-4.1-mini",

  // O-series aliases
  o1: "o1-2025-04-16",
  o3: "o3-2025-04-16",
  "o3-mini": "o3-mini-2025-04-16",

  // Gemini aliases
  gemini: "gemini-3-pro",
  "gemini-pro": "gemini-3-pro",
  "gemini-3": "gemini-3-pro",
  "gemini-2.5": "gemini-2.5-pro",
};

/**
 * Resolve a model alias to its full model ID.
 * Returns the input if no alias exists.
 */
export function resolveOpencodeZenAlias(modelIdOrAlias: string): string {
  const normalized = modelIdOrAlias.toLowerCase().trim();
  return OPENCODE_ZEN_MODEL_ALIASES[normalized] ?? modelIdOrAlias;
}

/**
 * OpenCode Zen is an OpenAI-compatible proxy for all models.
 * All requests go through /chat/completions regardless of the underlying model.
 */
export function resolveOpencodeZenModelApi(_modelId: string): ModelApi {
  return "openai-completions";
}

/**
 * Check if a model is a reasoning model (extended thinking).
 */
function isReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("opus") ||
    lower.startsWith("o1-") ||
    lower.startsWith("o3-") ||
    lower.startsWith("o4-") ||
    lower.includes("-thinking")
  );
}

/**
 * Check if a model supports image input.
 */
function supportsImageInput(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  // Most modern models support images, except some reasoning-only models
  if (lower.startsWith("o1-") || lower.startsWith("o3-")) {
    return false;
  }
  return true;
}

// Default cost structure (per million tokens, in USD cents)
// These are approximate; actual costs depend on OpenCode Zen pricing
const DEFAULT_COST = {
  input: 0, // Included in subscription
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Default context windows by model family
function getDefaultContextWindow(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes("opus")) return 200000;
  if (lower.includes("sonnet")) return 200000;
  if (lower.includes("haiku")) return 200000;
  if (lower.includes("gpt-5")) return 256000;
  if (lower.includes("gpt-4")) return 128000;
  if (lower.startsWith("o1-") || lower.startsWith("o3-")) return 200000;
  if (lower.includes("gemini-3")) return 1000000;
  if (lower.includes("gemini-2.5")) return 1000000;
  if (lower.includes("gemini")) return 128000;
  return 128000; // Conservative default
}

function getDefaultMaxTokens(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes("opus")) return 32000;
  if (lower.includes("sonnet")) return 16000;
  if (lower.includes("haiku")) return 8192;
  if (lower.startsWith("o1-") || lower.startsWith("o3-")) return 100000;
  if (lower.includes("gpt")) return 16384;
  if (lower.includes("gemini")) return 8192;
  return 8192;
}

/**
 * Build a ModelDefinitionConfig from a model ID.
 */
function buildModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: formatModelName(modelId),
    api: resolveOpencodeZenModelApi(modelId),
    reasoning: isReasoningModel(modelId),
    input: supportsImageInput(modelId) ? ["text", "image"] : ["text"],
    cost: DEFAULT_COST,
    contextWindow: getDefaultContextWindow(modelId),
    maxTokens: getDefaultMaxTokens(modelId),
  };
}

/**
 * Format a model ID into a human-readable name.
 */
function formatModelName(modelId: string): string {
  // Handle common patterns
  const replacements: Record<string, string> = {
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-sonnet-4-20250514": "Claude Sonnet 4",
    "claude-haiku-3-5-20241022": "Claude Haiku 3.5",
    "gpt-5.2": "GPT-5.2",
    "gpt-4.1": "GPT-4.1",
    "gpt-4.1-mini": "GPT-4.1 Mini",
    "o1-2025-04-16": "O1",
    "o3-2025-04-16": "O3",
    "o3-mini-2025-04-16": "O3 Mini",
    "gemini-3-pro": "Gemini 3 Pro",
    "gemini-2.5-pro": "Gemini 2.5 Pro",
    "gemini-2.5-flash": "Gemini 2.5 Flash",
  };

  if (replacements[modelId]) {
    return replacements[modelId];
  }

  // Generic formatting: capitalize and replace dashes
  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Static fallback models when API is unreachable.
 * These are the most commonly used models.
 */
export function getOpencodeZenStaticFallbackModels(): ModelDefinitionConfig[] {
  const modelIds = [
    // Claude models
    "claude-opus-4-5",
    "claude-sonnet-4-20250514",
    "claude-haiku-3-5-20241022",

    // GPT models
    "gpt-5.2",
    "gpt-4.1",
    "gpt-4.1-mini",

    // O-series reasoning models
    "o1-2025-04-16",
    "o3-2025-04-16",
    "o3-mini-2025-04-16",

    // Gemini models
    "gemini-3-pro",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ];

  return modelIds.map(buildModelDefinition);
}

/**
 * Response shape from OpenCode Zen /models endpoint.
 * Returns OpenAI-compatible format.
 */
interface ZenModelsResponse {
  data: Array<{
    id: string;
    object: "model";
    created?: number;
    owned_by?: string;
  }>;
}

/**
 * Fetch models from the OpenCode Zen API.
 * Uses caching with 1-hour TTL.
 *
 * @param apiKey - OpenCode Zen API key for authentication
 * @returns Array of model definitions, or static fallback on failure
 */
export async function fetchOpencodeZenModels(
  apiKey?: string,
): Promise<ModelDefinitionConfig[]> {
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

    const response = await fetch(`${OPENCODE_ZEN_API_BASE_URL}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(
        `API returned ${response.status}: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as ZenModelsResponse;

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from /models endpoint");
    }

    const models = data.data.map((model) => buildModelDefinition(model.id));

    cachedModels = models;
    cacheTimestamp = now;

    return models;
  } catch (error) {
    console.warn(
      `[opencode-zen] Failed to fetch models, using static fallback: ${String(error)}`,
    );
    return getOpencodeZenStaticFallbackModels();
  }
}

/**
 * Clear the model cache (useful for testing or forcing refresh).
 */
export function clearOpencodeZenModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}
