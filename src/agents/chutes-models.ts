import type { ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("chutes-models");

export const CHUTES_BASE_URL = "https://llm.chutes.ai/v1";

const CHUTES_DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cachedModels: ModelDefinitionConfig[] | null = null;
let cacheTimestamp = 0;

export const CHUTES_DEFAULT_MODEL_ID = "meta-llama/Llama-3.3-70B-Instruct";
export const CHUTES_DEFAULT_MODEL_REF = `chutes/${CHUTES_DEFAULT_MODEL_ID}`;

export const CHUTES_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function buildChutesModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name ?? params.id,
    reasoning: params.reasoning ?? false,
    input: (params.input ?? ["text"]) as ("text" | "image")[],
    cost: CHUTES_DEFAULT_COST,
    contextWindow: params.contextWindow ?? 128000,
    maxTokens: params.maxTokens ?? 8192,
  };
}

interface ChutesModelEntry {
  id: string;
  name?: string;
  context_window?: number;
}

interface ChutesModelsResponse {
  data?: ChutesModelEntry[];
}

function getChutesStaticFallbackModels(): ModelDefinitionConfig[] {
  return [
    buildChutesModelDefinition({
      id: CHUTES_DEFAULT_MODEL_ID,
      name: "Llama 3.3 70B",
    }),
    buildChutesModelDefinition({
      id: "meta-llama/Llama-3.1-70B-Instruct",
      name: "Llama 3.1 70B",
    }),
    buildChutesModelDefinition({
      id: "Qwen/Qwen2.5-72B-Instruct",
      name: "Qwen 2.5 72B",
      reasoning: true,
    }),
    buildChutesModelDefinition({
      id: "deepseek-ai/DeepSeek-V3",
      name: "DeepSeek V3",
      reasoning: true,
    }),
    buildChutesModelDefinition({
      id: "microsoft/WizardLM-2-8x22B",
      name: "WizardLM 2 8x22B",
    }),
  ];
}

export async function discoverChutesModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CHUTES_DISCOVERY_CACHE_TTL_MS) {
    return cachedModels;
  }

  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return getChutesStaticFallbackModels();
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${CHUTES_BASE_URL}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as ChutesModelsResponse;

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from /models endpoint");
    }

    const models = data.data.map((entry) =>
      buildChutesModelDefinition({
        id: entry.id,
        name: entry.name,
        contextWindow: entry.context_window,
      }),
    );

    cachedModels = models;
    cacheTimestamp = now;

    log.info("discovered chutes models", { count: models.length });
    return models;
  } catch (error) {
    log.warn(`Failed to discover Chutes models, using static fallback: ${String(error)}`);
    return getChutesStaticFallbackModels();
  }
}

export function clearChutesModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}
