import type { ModelDefinitionConfig } from "../config/types.js";

export type DashscopeRegion = "cn" | "intl" | "us";

export const DASHSCOPE_REGION_BASE_URL: Record<DashscopeRegion, string> = {
  cn: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  intl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  us: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
};

export const DASHSCOPE_BASE_URL = DASHSCOPE_REGION_BASE_URL.cn;
export const DASHSCOPE_DEFAULT_MODEL_ID = "qwen3-max";
export const DASHSCOPE_DEFAULT_MODEL_REF = `dashscope/${DASHSCOPE_DEFAULT_MODEL_ID}`;
export const DASHSCOPE_DEFAULT_CONTEXT_WINDOW = 262144;
export const DASHSCOPE_DEFAULT_MAX_TOKENS = 65536;
export const DASHSCOPE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildDashscopeModelDefinition(): ModelDefinitionConfig {
  return {
    id: DASHSCOPE_DEFAULT_MODEL_ID,
    name: "Qwen3 Max",
    reasoning: false,
    input: ["text"],
    cost: DASHSCOPE_DEFAULT_COST,
    contextWindow: DASHSCOPE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: DASHSCOPE_DEFAULT_MAX_TOKENS,
  };
}

export function buildDashscopeModelDefinitionById(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: DASHSCOPE_DEFAULT_COST,
    contextWindow: DASHSCOPE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: DASHSCOPE_DEFAULT_MAX_TOKENS,
  };
}
