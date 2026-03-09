import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";

export const OPENCODE_GO_API_BASE_URL = "https://opencode.ai/zen/go/v1";
export const OPENCODE_GO_DEFAULT_MODEL = "kimi-k2.5";
export const OPENCODE_GO_DEFAULT_MODEL_REF = `opencode-go/${OPENCODE_GO_DEFAULT_MODEL}`;

export const OPENCODE_GO_MODEL_ALIASES: Record<string, string> = {
  kimi: "kimi-k2.5",
  "kimi-k2.5": "kimi-k2.5",
  glm: "glm-5",
  "glm-5": "glm-5",
  minimax: "minimax-m2.5",
  m2: "minimax-m2.5",
  "m2.5": "minimax-m2.5",
  "minimax-m2.5": "minimax-m2.5",
};

export function resolveOpencodeGoAlias(modelIdOrAlias: string): string {
  const normalized = modelIdOrAlias.toLowerCase().trim();
  return OPENCODE_GO_MODEL_ALIASES[normalized] ?? modelIdOrAlias;
}

export function resolveOpencodeGoModelApi(modelId: string): ModelApi {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("minimax-")) {
    return "anthropic-messages";
  }
  return "openai-completions";
}

const MODEL_NAMES: Record<string, string> = {
  "kimi-k2.5": "Kimi K2.5",
  "glm-5": "GLM-5",
  "minimax-m2.5": "MiniMax M2.5",
};

export function getOpencodeGoStaticFallbackModels(): ModelDefinitionConfig[] {
  return [
    {
      id: "kimi-k2.5",
      name: MODEL_NAMES["kimi-k2.5"],
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 16384,
    },
    {
      id: "glm-5",
      name: MODEL_NAMES["glm-5"],
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 16384,
    },
    {
      id: "minimax-m2.5",
      name: MODEL_NAMES["minimax-m2.5"],
      api: "anthropic-messages",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 196608,
      maxTokens: 8192,
    },
  ];
}
