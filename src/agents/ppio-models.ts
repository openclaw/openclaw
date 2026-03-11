import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("ppio-models");

export const PPIO_BASE_URL = "https://api.ppinfra.com/v3/openai";
export const PPIO_DEFAULT_MODEL_ID = "deepseek/deepseek-v3.2";
export const PPIO_DEFAULT_MODEL_REF = `ppio/${PPIO_DEFAULT_MODEL_ID}`;

const PPIO_DISCOVERY_TIMEOUT_MS = 10_000;

// PPIO prices are in 0.0001 CNY per million tokens.
// Convert to USD/M tokens using approximate rate (1 USD ≈ 7.2 CNY).
// This is for rough cost display only. Review periodically.
// Last verified: 2026-03-11
const CNY_PER_UNIT = 0.0001;
const CNY_TO_USD = 1 / 7.2;

function ppioRawPriceToUsd(raw: number): number {
  return raw * CNY_PER_UNIT * CNY_TO_USD;
}

interface PpioApiModel {
  id: string;
  display_name?: string;
  model_type?: string;
  context_size?: number;
  max_output_tokens?: number;
  features?: string[];
  endpoints?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  input_token_price_per_m?: number;
  output_token_price_per_m?: number;
}

interface PpioModelsResponse {
  data?: PpioApiModel[];
}

function buildPpioModelFromApi(m: PpioApiModel): ModelDefinitionConfig | null {
  if (!m.id) {
    return null;
  }
  const features = (m.features ?? []).filter((f) => f !== "serverless");
  const reasoning = features.includes("reasoning");
  const inputModalities = m.input_modalities ?? ["text"];
  const input: Array<"text" | "image"> = ["text"];
  if (inputModalities.includes("image") || inputModalities.includes("video")) {
    input.push("image");
  }
  const inputPrice = ppioRawPriceToUsd(m.input_token_price_per_m ?? 0);
  const outputPrice = ppioRawPriceToUsd(m.output_token_price_per_m ?? 0);
  return {
    id: m.id,
    name: m.display_name || m.id,
    reasoning,
    input,
    contextWindow: m.context_size ?? 32768,
    maxTokens: m.max_output_tokens ?? 8192,
    cost: {
      input: inputPrice,
      output: outputPrice,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

export async function discoverPpioModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return staticPpioModelDefinitions();
  }

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${PPIO_BASE_URL}/models`, {
      headers,
      signal: AbortSignal.timeout(PPIO_DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(`Failed to discover PPIO models: HTTP ${response.status}, using static catalog`);
      return staticPpioModelDefinitions();
    }

    const data = (await response.json()) as PpioModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No PPIO models returned from API, using static catalog");
      return staticPpioModelDefinitions();
    }

    const models: ModelDefinitionConfig[] = [];
    for (const m of data.data) {
      if (m.model_type !== "chat") {
        continue;
      }
      const def = buildPpioModelFromApi(m);
      if (def) {
        models.push(def);
      }
    }

    if (models.length === 0) {
      return staticPpioModelDefinitions();
    }
    return models;
  } catch (error) {
    log.warn(`Failed to discover PPIO models: ${String(error)}, using static catalog`);
    return staticPpioModelDefinitions();
  }
}

/**
 * Static fallback catalog with the most popular PPIO models.
 * Used when the discovery API is unreachable.
 */
export function staticPpioModelDefinitions(): ModelDefinitionConfig[] {
  return PPIO_MODEL_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: entry.input as Array<"text" | "image">,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    cost: {
      input: ppioRawPriceToUsd(entry.rawInputPrice),
      output: ppioRawPriceToUsd(entry.rawOutputPrice),
      cacheRead: 0,
      cacheWrite: 0,
    },
  }));
}

interface PpioCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  /** Raw price in 0.0001 CNY per million tokens */
  rawInputPrice: number;
  /** Raw price in 0.0001 CNY per million tokens */
  rawOutputPrice: number;
}

// Note: reasoning flags are sourced from PPIO's /models API `features` array.
// PPIO classifies DeepSeek V3.1/V3.2 as reasoning-capable (they return
// "reasoning" in features), unlike the older V3-0324 which does not.
export const PPIO_MODEL_CATALOG: PpioCatalogEntry[] = [
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: true,
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 65536,
    rawInputPrice: 20000,
    rawOutputPrice: 30000,
  },
  {
    id: "deepseek/deepseek-r1-0528",
    name: "DeepSeek R1 0528",
    reasoning: true,
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 32768,
    rawInputPrice: 40000,
    rawOutputPrice: 160000,
  },
  {
    id: "deepseek/deepseek-v3.1",
    name: "DeepSeek V3.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    rawInputPrice: 40000,
    rawOutputPrice: 120000,
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 262144,
    rawInputPrice: 40000,
    rawOutputPrice: 210000,
  },
  {
    id: "moonshotai/kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 262144,
    rawInputPrice: 40000,
    rawOutputPrice: 160000,
  },
  {
    id: "moonshotai/kimi-k2-instruct",
    name: "Kimi K2 Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 128000,
    rawInputPrice: 40000,
    rawOutputPrice: 160000,
  },
  {
    id: "qwen/qwen3-235b-a22b-thinking-2507",
    name: "Qwen3-235B-A22B Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 114688,
    rawInputPrice: 20000,
    rawOutputPrice: 200000,
  },
  {
    id: "qwen/qwen3-235b-a22b-instruct-2507",
    name: "Qwen3-235B-A22B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 260000,
    rawInputPrice: 14500,
    rawOutputPrice: 58000,
  },
  {
    id: "qwen/qwen3-coder-480b-a35b-instruct",
    name: "Qwen3-Coder-480B-A35B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 65536,
    rawInputPrice: 40000,
    rawOutputPrice: 160000,
  },
  {
    id: "qwen/qwen3.5-397b-a17b",
    name: "Qwen3.5-397B-A17B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    rawInputPrice: 30000,
    rawOutputPrice: 180000,
  },
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131100,
    rawInputPrice: 21000,
    rawOutputPrice: 84000,
  },
  {
    id: "minimax/minimax-m2.5-highspeed",
    name: "MiniMax M2.5 Highspeed",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131100,
    rawInputPrice: 42000,
    rawOutputPrice: 168000,
  },
  {
    id: "zai-org/glm-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 202800,
    maxTokens: 131072,
    rawInputPrice: 60000,
    rawOutputPrice: 220000,
  },
  {
    id: "zai-org/glm-4.7",
    name: "GLM-4.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131072,
    rawInputPrice: 40000,
    rawOutputPrice: 160000,
  },
];
