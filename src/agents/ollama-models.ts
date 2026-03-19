import type { ModelDefinitionConfig } from "../config/types.models.js";
import { OLLAMA_DEFAULT_BASE_URL } from "./ollama-defaults.js";

export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
export const OLLAMA_EXTENDED_CONTEXT_WINDOW = 262144; // 256K default for newer models
export const OLLAMA_MEGA_CONTEXT_WINDOW = 2097152; // 2M context window support
export const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
export const OLLAMA_EXTENDED_MAX_TOKENS = 32768; // Extended max tokens for large models
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
    parameter_size?: string;
    quantization_level?: string;
  };
};

export type OllamaTagsResponse = {
  models?: OllamaTagModel[];
};

export type OllamaModelWithContext = OllamaTagModel & {
  contextWindow?: number;
  maxTokens?: number;
  isLocal?: boolean;
};

const OLLAMA_SHOW_CONCURRENCY = 8;
const CONTEXT_WINDOW_CACHE = new Map<string, { contextWindow: number; timestamp: number }>();
const CACHE_TTL = 300000; // 5 minutes cache TTL

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

/**
 * Enhanced context window detection with caching and fallback strategies
 */
export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  // Check cache first
  const cached = CONTEXT_WINDOW_CACHE.get(modelName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.contextWindow;
  }

  try {
    // Try the modern /api/show endpoint first
    const response = await fetch(`${apiBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5000),
    });
    
    if (!response.ok) {
      // No redundant legacy fallback - if /api/show fails, use estimation
      return estimateContextWindow(modelName);
    }
    
    const data = (await response.json()) as { model_info?: Record<string, unknown> };
    if (!data.model_info) {
      // Fallback if no model info
      return estimateContextWindow(modelName);
    }
    
    // Look for context window information in model info
    let contextWindow: number | undefined;
    
    for (const [key, value] of Object.entries(data.model_info)) {
      if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
        const detectedWindow = Math.floor(value);
        if (detectedWindow > 0) {
          contextWindow = detectedWindow;
          break;
        }
      }
      
      // Also check for BERT-style max_position_embeddings
      if (key.includes("max_position_embeddings") && typeof value === "number" && Number.isFinite(value)) {
        const detectedWindow = Math.floor(value);
        if (detectedWindow > 0) {
          contextWindow = detectedWindow;
          break;
        }
      }
    }
    
    // If not found, try to estimate based on model name and parameters
    if (contextWindow === undefined) {
      contextWindow = estimateContextWindow(modelName, data.model_info);
    }
    
    // Cache the result
    if (contextWindow !== undefined) {
      CONTEXT_WINDOW_CACHE.set(modelName, { 
        contextWindow, 
        timestamp: Date.now() 
      });
    }
    
    return contextWindow;
  } catch (error) {
    // Fallback to estimation on error
    const estimated = estimateContextWindow(modelName);
    if (estimated !== undefined) {
      CONTEXT_WINDOW_CACHE.set(modelName, { 
        contextWindow: estimated, 
        timestamp: Date.now() 
      });
    }
    return estimated;
  }
}

/**
 * Intelligent context window estimation based on model name and properties
 */
function estimateContextWindow(
  modelName: string,
  modelInfo?: Record<string, unknown>
): number | undefined {
  const name = modelName.toLowerCase();
  
  // Check for explicit context window in model info
  if (modelInfo) {
    for (const [key, value] of Object.entries(modelInfo)) {
      if (key.includes('context') && typeof value === 'number' && value > 0) {
        return Math.min(Math.floor(value), OLLAMA_MEGA_CONTEXT_WINDOW);
      }
    }
  }
  
  // Qwen3 series - known for large context support
  if (name.includes('qwen3') || name.includes('qwen-3')) {
    if (name.includes('128k') || name.includes('128K')) return 131072;
    if (name.includes('256k') || name.includes('256K')) return 262144;
    if (name.includes('1m') || name.includes('1M')) return 1048576;
    if (name.includes('2m') || name.includes('2M')) return OLLAMA_MEGA_CONTEXT_WINDOW;
    return OLLAMA_EXTENDED_CONTEXT_WINDOW; // Default 256K for Qwen3
  }
  
  // GLM series
  if (name.includes('glm') && (name.includes('5') || name.includes('4'))) {
    if (name.includes('128k')) return 131072;
    return OLLAMA_EXTENDED_CONTEXT_WINDOW;
  }
  
  // DeepSeek series
  if (name.includes('deepseek') && name.includes('v3')) {
    return OLLAMA_MEGA_CONTEXT_WINDOW; // 2M context for DeepSeek V3
  }
  
  // Kimi series
  if (name.includes('kimi') && (name.includes('k2') || name.includes('2.5'))) {
    return OLLAMA_MEGA_CONTEXT_WINDOW;
  }
  
  // Large models with likely extended context
  if (name.includes('llama3') || name.includes('llama-3')) {
    if (name.includes('70b') || name.includes('70B')) {
      return OLLAMA_EXTENDED_CONTEXT_WINDOW;
    }
    if (name.includes('405b') || name.includes('405B')) {
      return OLLAMA_MEGA_CONTEXT_WINDOW;
    }
  }
  
  // Code models often have extended context
  if (name.includes('code') || name.includes('coder')) {
    if (name.includes('34b') || name.includes('34B')) {
      return OLLAMA_EXTENDED_CONTEXT_WINDOW;
    }
  }
  
  // Return default if no specific match
  return undefined;
}

export async function enrichOllamaModelsWithContext(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: { concurrency?: number; enableMegaContext?: boolean },
): Promise<OllamaModelWithContext[]> {
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
  const enableMegaContext = opts?.enableMegaContext ?? false;
  
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += concurrency) {
    const batch = models.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const contextWindow = await queryOllamaContextWindow(apiBase, model.name);
        const maxTokens = determineMaxTokens(model.name, contextWindow);
        const isLocal = detectLocalModel(model);
        
        return {
          ...model,
          contextWindow: enableMegaContext && contextWindow ? 
            Math.min(contextWindow * 2, OLLAMA_MEGA_CONTEXT_WINDOW) : 
            contextWindow,
          maxTokens,
          isLocal,
        };
      }),
    );
    enriched.push(...batchResults);
  }
  return enriched;
}

/**
 * Determine appropriate max tokens based on context window
 */
function determineMaxTokens(modelName: string, contextWindow?: number): number {
  if (!contextWindow) {
    return OLLAMA_DEFAULT_MAX_TOKENS;
  }
  
  // For very large context windows, allow larger max tokens
  if (contextWindow >= OLLAMA_MEGA_CONTEXT_WINDOW) {
    return OLLAMA_EXTENDED_MAX_TOKENS;
  }
  
  if (contextWindow >= OLLAMA_EXTENDED_CONTEXT_WINDOW) {
    return Math.min(OLLAMA_EXTENDED_MAX_TOKENS, Math.floor(contextWindow * 0.25));
  }
  
  return OLLAMA_DEFAULT_MAX_TOKENS;
}

/**
 * Detect if model is likely running locally
 */
function detectLocalModel(model: OllamaTagModel): boolean {
  // Check for local indicators in model name
  const name = model.name.toLowerCase();
  return !name.includes('api') && 
         !name.includes('cloud') && 
         !name.includes('remote') &&
         !model.remote_host;
}

/**
 * Heuristic: treat models with known reasoning-capable name patterns as
 * reasoning models.  The list is intentionally broad to cover the rapidly
 * evolving open-source landscape (2025-2026).
 *
 * Patterns added by manusilized:
 *   - qwen3          (Qwen3 series – all variants have extended thinking)
 *   - qwq            (QwQ reasoning model family)
 *   - glm-?5 / glm5   (GLM-5 supports deep reasoning)
 *   - kimi-?k2 / k2.5 (Kimi K2.5 trillion-parameter reasoning)
 *   - marco-o1       (Marco-o1 reasoning model)
 *   - skywork-o      (Skywork-o series)
 *   - llama.*reason  (Llama variants with reasoning capability)
 *   - yi.*1.5        (Yi 1.5 series reasoning models)
 * 
 * Excluded patterns (not reasoning models):
 *   - deepseek-v3    (not a reasoning model)
 *   - mistral.*large (not a reasoning model)
 *   - command.*r     (not a reasoning model)
 */
export function isReasoningModelHeuristic(modelId: string): boolean {
  const id = modelId.toLowerCase();
  
  // Exclude non-reasoning models
  if (/deepseek-v3|mistral.*large|command.*r/i.test(id)) {
    return false;
  }
  
  // Check for reasoning model patterns
  return /r1|reasoning|think|reason|qwen3|qwq|glm-?5|kimi-?k2|marco-o|skywork-o|llama.*reason|yi.*1\.5/i.test(
    id,
  );
}

/**
 * Enhanced model definition with support for mega-context windows
 */
export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
  maxTokens?: number,
): ModelDefinitionConfig {
  // Determine if this is a reasoning model
  const isReasoning = isReasoningModelHeuristic(modelId);
  
  // Use provided values or defaults
  const effectiveContextWindow = contextWindow ?? 
    (isReasoning ? OLLAMA_EXTENDED_CONTEXT_WINDOW : OLLAMA_DEFAULT_CONTEXT_WINDOW);
    
  const effectiveMaxTokens = maxTokens ?? 
    (effectiveContextWindow >= OLLAMA_MEGA_CONTEXT_WINDOW ? 
      OLLAMA_EXTENDED_MAX_TOKENS : 
      OLLAMA_DEFAULT_MAX_TOKENS);
  
  // Use sensible default output token limits, NOT a percentage of context window
  // No model can realistically output 1M tokens in a single turn
  const maxOutputTokens = effectiveContextWindow >= OLLAMA_MEGA_CONTEXT_WINDOW 
    ? OLLAMA_EXTENDED_MAX_TOKENS  // 32K for mega context models
    : OLLAMA_DEFAULT_MAX_TOKENS;   // 8K for standard models
  
  return {
    id: modelId,
    name: modelId,
    reasoning: isReasoning,
    input: ["text"],
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: Math.min(effectiveContextWindow, OLLAMA_MEGA_CONTEXT_WINDOW),
    maxTokens: Math.min(effectiveMaxTokens, maxOutputTokens),
  };
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

/**
 * Predefined context windows for popular models
 */
export const PREDEFINED_CONTEXT_WINDOWS: Record<string, number> = {
  'qwen3': 262144,
  'qwen3:4b': 262144,
  'qwen3:8b': 262144,
  'qwen3:32b': 262144,
  'qwen3:72b': 262144,
  'qwen3:110b': 2097152, // 2M context
  'glm-5': 262144,
  'glm-5-air': 262144,
  'glm-5-pro': 2097152, // 2M context
  'deepseek-v3': 2097152, // 2M context
  'kimi-k2.5': 2097152, // 2M context
  'llama3.1:8b': 131072,
  'llama3.1:70b': 131072,
  'llama3.1:405b': 2097152, // 2M context
  'mistral-large': 131072,
  'yi-1.5:9b': 32768,
  'yi-1.5:34b': 262144,
};