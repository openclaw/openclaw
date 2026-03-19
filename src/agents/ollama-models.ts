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
    parameter_size?: string;
  };
};

export type OllamaTagsResponse = {
  models?: OllamaTagModel[];
};

export type OllamaModelWithContext = OllamaTagModel & {
  contextWindow?: number;
  vision?: boolean;
};

const OLLAMA_SHOW_CONCURRENCY = 8;

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

export type OllamaShowInfo = {
  contextWindow?: number;
  vision?: boolean;
};

export async function queryOllamaModelInfo(
  apiBase: string,
  modelName: string,
): Promise<OllamaShowInfo> {
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
    const data = (await response.json()) as { model_info?: Record<string, unknown> };
    if (!data.model_info) {
      return {};
    }
    let contextWindow: number | undefined;
    let vision = false;
    for (const key of Object.keys(data.model_info)) {
      if (key.endsWith(".context_length") && !contextWindow) {
        const value = data.model_info[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          const ctx = Math.floor(value);
          if (ctx > 0) {
            contextWindow = ctx;
          }
        }
      }
      // Ollama vision models expose projector/clip architecture keys in model_info
      if (key.startsWith("clip.") || key.startsWith("projector.")) {
        vision = true;
      }
    }
    return { contextWindow, vision };
  } catch {
    return {};
  }
}

/** @deprecated Use queryOllamaModelInfo instead. */
export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  const info = await queryOllamaModelInfo(apiBase, modelName);
  return info.contextWindow;
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
        const info = await queryOllamaModelInfo(apiBase, model.name);
        return {
          ...model,
          contextWindow: info.contextWindow,
          vision: info.vision || isVisionModelHeuristic(model.name),
        };
      }),
    );
    enriched.push(...batchResults);
  }
  return enriched;
}

/** Heuristic: treat models with "r1", "reasoning", or "think" in the name as reasoning models. */
export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

/**
 * Heuristic: detect vision/multimodal models by name.
 * Covers common Ollama vision model naming patterns:
 * - `-vl` / `_vl` suffix (qwen3-vl, internvl)
 * - `vision` (llama3.2-vision)
 * - `llava` / `bakllava` (LLaVA family)
 * - `moondream` (small vision model)
 * - `minicpm-v` (MiniCPM-V family)
 */
export function isVisionModelHeuristic(modelId: string): boolean {
  return /[-_]vl\b|nvl\d|vision|llava|bakllava|moondream|minicpm-v/i.test(modelId);
}

/** Build a ModelDefinitionConfig for an Ollama model with default values. */
export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
  opts?: { vision?: boolean },
): ModelDefinitionConfig {
  const vision = opts?.vision || isVisionModelHeuristic(modelId);
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
