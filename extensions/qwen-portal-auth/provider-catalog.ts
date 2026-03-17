import type { ModelDefinitionConfig, ModelProviderConfig } from "../../src/config/types.models.js";

export const QWEN_PORTAL_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW = 128000;
const QWEN_PORTAL_DEFAULT_MAX_TOKENS = 8192;
const QWEN_PORTAL_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function buildModelDefinition(params: {
  id: string;
  name: string;
  input: ModelDefinitionConfig["input"];
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: false,
    input: params.input,
    cost: QWEN_PORTAL_DEFAULT_COST,
    contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
    maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS,
  };
}

export function buildQwenPortalProvider(): ModelProviderConfig {
  return {
    baseUrl: QWEN_PORTAL_BASE_URL,
    api: "openai-completions",
    models: [
      buildModelDefinition({
        id: "coder-model",
        name: "Qwen Coder",
        input: ["text"],
      }),
      buildModelDefinition({
        id: "vision-model",
        name: "Qwen Vision",
        input: ["text", "image"],
      }),
    ],
  };
}
