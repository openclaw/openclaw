import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";

export const MODELSTUDIO_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
export const MODELSTUDIO_GLOBAL_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
export const MODELSTUDIO_DEFAULT_MODEL_ID = "qwen3.5-plus";
export const MODELSTUDIO_DEFAULT_MODEL_REF = `modelstudio/${MODELSTUDIO_DEFAULT_MODEL_ID}`;
export const MODELSTUDIO_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const MODELSTUDIO_MODEL_CATALOG = {
  "qwen3.5-plus": {
    name: "qwen3.5-plus",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  "qwen3-max-2026-01-23": {
    name: "qwen3-max-2026-01-23",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "qwen3-coder-next": {
    name: "qwen3-coder-next",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "qwen3-coder-plus": {
    name: "qwen3-coder-plus",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  "MiniMax-M2.5": {
    name: "MiniMax-M2.5",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  "glm-5": {
    name: "glm-5",
    reasoning: false,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 16384,
  },
  "glm-4.7": {
    name: "glm-4.7",
    reasoning: false,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 16384,
  },
  "kimi-k2.5": {
    name: "kimi-k2.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
  },
} as const;

type ModelStudioCatalogId = keyof typeof MODELSTUDIO_MODEL_CATALOG;

export function buildModelStudioModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = MODELSTUDIO_MODEL_CATALOG[params.id as ModelStudioCatalogId];
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input:
      (params.input as ("text" | "image")[]) ??
      ([...(catalog?.input ?? ["text"])] as ("text" | "image")[]),
    cost: params.cost ?? MODELSTUDIO_DEFAULT_COST,
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 262144,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 65536,
  };
}

export function buildModelStudioDefaultModelDefinition(): ModelDefinitionConfig {
  return buildModelStudioModelDefinition({
    id: MODELSTUDIO_DEFAULT_MODEL_ID,
  });
}
