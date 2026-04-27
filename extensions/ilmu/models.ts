import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const ILMU_BASE_URL = "https://api.ilmu.ai/v1";

const ILMU_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const ILMU_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "nemo-super",
    name: "ILMU Nemo Super",
    reasoning: true,
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: 128_000,
    cost: ILMU_ZERO_COST,
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  },
  {
    id: "ilmu-nemo-nano",
    name: "ILMU Nemo Nano",
    reasoning: true,
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: 128_000,
    cost: ILMU_ZERO_COST,
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  },
];

export function buildIlmuModelDefinition(
  model: (typeof ILMU_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
