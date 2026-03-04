import type { ModelDefinitionConfig } from "../config/types.js";

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_GO_DEFAULT_MODEL_ID = "kimi-k2.5";
export const OPENCODE_GO_DEFAULT_MODEL_REF = `opencode-go/${OPENCODE_GO_DEFAULT_MODEL_ID}`;

const DEFAULT_MAX_TOKENS = 8192;
const MINIMAX_CONTEXT_WINDOW = 200000;
const KIMI_CONTEXT_WINDOW = 256000;
const GLM_CONTEXT_WINDOW = 204800;

const GLM_5_COST = {
  input: 1,
  output: 3.2,
  cacheRead: 0.2,
  cacheWrite: 0,
};

const KIMI_K25_COST = {
  input: 0.6,
  output: 3,
  cacheRead: 0.1,
  cacheWrite: 0,
};

const MINIMAX_M25_COST = {
  input: 0.3,
  output: 1.2,
  cacheRead: 0.06,
  cacheWrite: 0.375,
};

export function buildOpencodeGoModelDefinition(modelId: string): ModelDefinitionConfig {
  if (modelId === "glm-5") {
    return {
      id: modelId,
      name: "GLM-5",
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      cost: GLM_5_COST,
      contextWindow: GLM_CONTEXT_WINDOW,
      maxTokens: 131072,
    };
  }

  if (modelId === "minimax-m2.5") {
    return {
      id: modelId,
      name: "MiniMax M2.5",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text"],
      cost: MINIMAX_M25_COST,
      contextWindow: MINIMAX_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  }

  if (modelId === "kimi-k2.5") {
    return {
      id: modelId,
      name: "Kimi K2.5",
      api: "openai-completions",
      reasoning: false,
      input: ["text", "image"],
      cost: KIMI_K25_COST,
      contextWindow: KIMI_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  }

  throw new Error(`Unsupported OpenCode Go model: ${modelId}`);
}

export const OPENCODE_GO_MODEL_CATALOG: ReadonlyArray<ModelDefinitionConfig> = [
  buildOpencodeGoModelDefinition("glm-5"),
  buildOpencodeGoModelDefinition("kimi-k2.5"),
  buildOpencodeGoModelDefinition("minimax-m2.5"),
];
