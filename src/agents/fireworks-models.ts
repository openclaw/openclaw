import type { ModelDefinitionConfig } from "../config/types.models.js";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const FIREWORKS_DEFAULT_MODEL_ID = "accounts/fireworks/models/kimi-k2p5";
export const FIREWORKS_DEFAULT_MODEL_REF = `fireworks/${FIREWORKS_DEFAULT_MODEL_ID}`;
export const FIREWORKS_DEFAULT_CONTEXT_WINDOW = 131072;
export const FIREWORKS_DEFAULT_MAX_TOKENS = 8192;
export const FIREWORKS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type FireworksCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
};

// Snapshot from Fireworks GET /inference/v1/models (2026-02-16, authenticated).
export const FIREWORKS_MODEL_CATALOG: ReadonlyArray<FireworksCatalogEntry> = [
  {
    id: "accounts/fireworks/models/kimi-k2-instruct-0905",
    name: "Kimi K2 Instruct 0905",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
  },
  {
    id: "accounts/fireworks/models/minimax-m2p5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 196608,
  },
  {
    id: FIREWORKS_DEFAULT_MODEL_ID,
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262144,
  },
  {
    id: "accounts/fireworks/models/flux-1-schnell-fp8",
    name: "FLUX.1 Schnell FP8",
    reasoning: false,
    input: ["text"],
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: "accounts/fireworks/models/glm-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
  },
  {
    id: "accounts/fireworks/models/gpt-oss-20b",
    name: "GPT OSS 20B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
  },
  {
    id: "accounts/fireworks/models/deepseek-v3p1",
    name: "DeepSeek V3.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 163840,
  },
  {
    id: "accounts/fireworks/models/flux-kontext-max",
    name: "FLUX Kontext Max",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: "accounts/fireworks/models/glm-4p7",
    name: "GLM-4.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
  },
  {
    id: "accounts/fireworks/models/minimax-m2p1",
    name: "MiniMax M2.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 204800,
  },
  {
    id: "accounts/fireworks/models/kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: "accounts/fireworks/models/mixtral-8x22b-instruct",
    name: "Mixtral 8x22B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 65536,
  },
  {
    id: "accounts/fireworks/models/flux-1-dev-fp8",
    name: "FLUX.1 Dev FP8",
    reasoning: false,
    input: ["text"],
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: "accounts/fireworks/models/flux-kontext-pro",
    name: "FLUX Kontext Pro",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: "accounts/fireworks/models/deepseek-v3p2",
    name: "DeepSeek V3.2",
    reasoning: true,
    input: ["text"],
    contextWindow: 163840,
  },
  {
    id: "accounts/fireworks/models/gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
  },
  {
    id: "accounts/cogito/models/cogito-671b-v2-p1",
    name: "Cogito 671B v2 p1",
    reasoning: false,
    input: ["text"],
    contextWindow: 163840,
  },
];

function toModelDefinition(entry: FireworksCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: entry.input,
    cost: FIREWORKS_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
  };
}

export function buildFireworksModelDefinitions(): ModelDefinitionConfig[] {
  return FIREWORKS_MODEL_CATALOG.map(toModelDefinition);
}

export function buildFireworksModelDefinition(params?: { id?: string }): ModelDefinitionConfig {
  const id = params?.id?.trim() || FIREWORKS_DEFAULT_MODEL_ID;
  const catalog = FIREWORKS_MODEL_CATALOG.find((entry) => entry.id === id);
  if (catalog) {
    return toModelDefinition(catalog);
  }
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: FIREWORKS_DEFAULT_COST,
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
  };
}
