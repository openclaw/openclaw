import type { ModelDefinitionConfig } from "../config/types.js";

// HuaweiCloud MAAS base URL and constants
export const HUAWEI_MAAS_API_BASE_URL = "https://api.modelarts-maas.com";
export const HUAWEI_MAAS_BASE_URL = "https://api.modelarts-maas.com";
export const HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW = 131072;
export const HUAWEI_MAAS_DEFAULT_MAX_TOKENS = 8192;
export const HUAWEI_MAAS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Shared default models for Huawei MAAS
export const HUAWEI_MAAS_DEFAULT_MODELS: ModelDefinitionConfig[] = [
  {
    id: "Kimi-K2",
    name: "Kimi K2",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "deepseek-v3.2",
    name: "Deepseek V3.2",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "qwen3-32b",
    name: "Qwen3 32b",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "deepseek-v3.2-exp",
    name: "Deepseek V3.2 Exp",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "deepseek-v3.1-terminus",
    name: "Deepseek V3.1 Terminus",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "qwen3-30b-a3b",
    name: "Qwen3 30b A3b",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480b A35b Instruct",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "qwen3-235b-a22b",
    name: "Qwen3 235b A22b",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "longcat-flash-chat",
    name: "Longcat Flash Chat",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "DeepSeek-V3",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "deepseek-r1-250528",
    name: "Deepseek R1 250528",
    reasoning: true,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
  {
    id: "deepseek-v3.1",
    name: "Deepseek V3.1",
    reasoning: false,
    input: ["text" as const],
    cost: HUAWEI_MAAS_DEFAULT_COST,
    contextWindow: HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
  },
];

// Huawei MAAS model interface
interface HuaweiMaasModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

// Huawei MAAS response interface
export interface HuaweiMaasResponse {
  object: string;
  data: HuaweiMaasModel[];
}

// Generate friendly model name from model ID
export function generateFriendlyModelName(modelId: string): string {
  // Convert model ID to more friendly name
  return modelId
    .split(/[-.]/)
    .map((part) => {
      // Handle first letter capitalization
      if (part.length > 0) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      }
      return part;
    })
    .join(" ");
}
