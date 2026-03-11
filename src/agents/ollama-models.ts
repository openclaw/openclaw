import type { ModelDefinitionConfig } from "../config/types.models.js";
import { OLLAMA_NATIVE_BASE_URL } from "./ollama-stream.js";

export const OLLAMA_DEFAULT_BASE_URL = OLLAMA_NATIVE_BASE_URL;
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
    parameter_size?: string;
  };
};

export type OllamaTagsResponse = {
  models?: OllamaTagModel[];
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
    return OLLAMA_DEFAULT_BASE_URL;
  }
  const trimmed = configuredBaseUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

/** Heuristic: treat models with "r1", "reasoning", or "think" in the name as reasoning models. */
export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

/** Build a ModelDefinitionConfig for an Ollama model with default values. */
export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    reasoning: isReasoningModelHeuristic(modelId),
    input: ["text"],
    cost: OLLAMA_DEFAULT_COST,
    contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
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
