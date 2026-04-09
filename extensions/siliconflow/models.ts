import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";

const SILICONFLOW_COST = {
  input: 0.1,
  output: 0.1,
  cacheRead: 0.01,
  cacheWrite: 0,
};

export const SILICONFLOW_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    name: "Qwen2.5-7B-Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: SILICONFLOW_COST,
    compat: { supportsUsageInStreaming: true },
  },
  {
    id: "Qwen/Qwen2.5-72B-Instruct",
    name: "Qwen2.5-72B-Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: SILICONFLOW_COST,
    compat: { supportsUsageInStreaming: true },
  },
  {
    id: "deepseek-ai/DeepSeek-V3",
    name: "DeepSeek-V3",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: SILICONFLOW_COST,
    compat: { supportsUsageInStreaming: true },
  },
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek-R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: SILICONFLOW_COST,
    compat: { supportsUsageInStreaming: true },
  },
];

export function buildSiliconFlowModelDefinition(
  model: (typeof SILICONFLOW_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
