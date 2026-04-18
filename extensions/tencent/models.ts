import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

// ---------- TokenHub provider ----------

export const TOKENHUB_BASE_URL = "https://tokenhub.tencentmaas.com/v1";
export const TOKENHUB_PROVIDER_ID = "tencent-tokenhub";

// HY3 pricing ($ per 1M tokens)
const HY3_COST = {
  input: 0.23,
  output: 0.59,
  cacheRead: 0.059,
  cacheWrite: 0,
};

export const TOKENHUB_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "hy3-preview",
    name: "HY3 Preview (TokenHub)",
    reasoning: true,
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: 64_000,
    cost: HY3_COST,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
    },
  },
];

export function buildTokenHubModelDefinition(
  model: (typeof TOKENHUB_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}

// ---------- Token Plan provider ----------

export const TOKEN_PLAN_BASE_URL = "https://api.lkeap.cloud.tencent.com/plan/v3";
export const TOKEN_PLAN_PROVIDER_ID = "tencent-token-plan";

export const TOKEN_PLAN_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "hy3-preview",
    name: "HY3 Preview (Token Plan)",
    reasoning: true,
    input: ["text"],
    contextWindow: 256_000,
    maxTokens: 64_000,
    cost: HY3_COST,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
    },
  },
];

export function buildTokenPlanModelDefinition(
  model: (typeof TOKEN_PLAN_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
