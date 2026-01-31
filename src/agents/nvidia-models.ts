/**
 * NVIDIA NIM model catalog with static model definitions.
 *
 * NVIDIA NIM provides access to AI models through an OpenAI-compatible API.
 *
 * API endpoint: https://integrate.api.nvidia.com/v1
 * Get API key: https://build.nvidia.com/
 */

import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";

export const NVIDIA_API_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_DEFAULT_MODEL = "meta/llama-3.3-70b-instruct";
export const NVIDIA_DEFAULT_MODEL_REF = `nvidia/${NVIDIA_DEFAULT_MODEL.split("/")[1]}`;

/**
 * Model aliases for convenient shortcuts.
 */
export const NVIDIA_MODEL_ALIASES: Record<string, string> = {
  // Llama models
  llama: "meta/llama-3.3-70b-instruct",
  "llama-70b": "meta/llama-3.3-70b-instruct",
  "llama-3.3": "meta/llama-3.3-70b-instruct",
  "llama-405b": "meta/llama-3.1-405b-instruct",
  "llama-4": "meta/llama-4-maverick-17b-128e-instruct",

  // DeepSeek models
  deepseek: "deepseek-ai/deepseek-v3.2",
  "deepseek-v3": "deepseek-ai/deepseek-v3.1",
  "deepseek-v3.1": "deepseek-ai/deepseek-v3.1",
  "deepseek-v3.2": "deepseek-ai/deepseek-v3.2",
  "deepseek-terminus": "deepseek-ai/deepseek-v3.1-terminus",
  "deepseek-r1": "deepseek-ai/deepseek-r1-distill-qwen-32b",

  // Qwen models
  qwen: "qwen/qwen3-235b-a22b",
  "qwen3": "qwen/qwen3-235b-a22b",
  "qwen3-coder": "qwen/qwen3-coder-480b-a35b-instruct",
  "qwen3-next": "qwen/qwen3-next-80b-a3b-instruct",
  "qwq": "qwen/qwq-32b",
  "qwen2.5-coder": "qwen/qwen2.5-coder-32b-instruct",

  // Mistral models
  mistral: "mistralai/mistral-large-3-675b-instruct-2512",
  "mistral-large": "mistralai/mistral-large-3-675b-instruct-2512",
  "mistral-medium": "mistralai/mistral-medium-3-instruct",
  "devstral": "mistralai/devstral-2-123b-instruct-2512",
  "mixtral": "mistralai/mixtral-8x22b-instruct-v0.1",

  // Kimi models
  kimi: "moonshotai/kimi-k2.5",
  "kimi-k2": "moonshotai/kimi-k2-instruct",
  "kimi-k2.5": "moonshotai/kimi-k2.5",
  "kimi-thinking": "moonshotai/kimi-k2-thinking",

  // MiniMax models
  minimax: "minimaxai/minimax-m2.1",
  "minimax-m2": "minimaxai/minimax-m2",
  "minimax-m2.1": "minimaxai/minimax-m2.1",

  // NVIDIA Nemotron models
  nemotron: "nvidia/llama-3.1-nemotron-70b-instruct",
  "nemotron-ultra": "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nemotron-super": "nvidia/llama-3.3-nemotron-super-49b-v1.5",

  // Microsoft Phi models
  phi: "microsoft/phi-4-mini-instruct",
  "phi-4": "microsoft/phi-4-mini-instruct",

  // Google Gemma models
  gemma: "google/gemma-3-27b-it",
  "gemma-3": "google/gemma-3-27b-it",
  "gemma-2": "google/gemma-2-27b-it",

  // GLM models (via Z.AI)
  glm: "z-ai/glm4.7",
  "glm-4.7": "z-ai/glm4.7",

  // IBM Granite
  granite: "ibm/granite-3.3-8b-instruct",

  // ByteDance Seed
  seed: "bytedance/seed-oss-36b-instruct",
};

/**
 * Resolve a model alias to its full model ID.
 * Returns the input if no alias exists.
 */
export function resolveNvidiaAlias(modelIdOrAlias: string): string {
  const normalized = modelIdOrAlias.toLowerCase().trim();
  return NVIDIA_MODEL_ALIASES[normalized] ?? modelIdOrAlias;
}

/**
 * NVIDIA NIM uses OpenAI-compatible API for all models.
 */
export function resolveNvidiaModelApi(_modelId: string): ModelApi {
  return "openai-completions";
}

/**
 * Check if a model supports image input.
 */
function supportsImageInput(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("vision") ||
    lower.includes("multimodal") ||
    lower.includes("paligemma") ||
    lower.includes("kosmos") ||
    lower.includes("vila") ||
    lower.includes("fuyu") ||
    lower.includes("neva") ||
    lower.includes("nvclip") ||
    lower.includes("-vl")
  );
}

/**
 * Check if a model supports reasoning/thinking.
 */
function supportsReasoning(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("deepseek-r1") ||
    lower.includes("thinking") ||
    lower.includes("reasoning") ||
    lower.includes("qwq") ||
    lower.includes("glm")
  );
}

// NVIDIA NIM models are generally free with API credits
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Meta Llama
  "meta/llama-3.3-70b-instruct": 128000,
  "meta/llama-3.1-405b-instruct": 128000,
  "meta/llama-3.1-70b-instruct": 128000,
  "meta/llama-3.1-8b-instruct": 128000,
  "meta/llama-3.2-90b-vision-instruct": 128000,
  "meta/llama-3.2-11b-vision-instruct": 128000,
  "meta/llama-4-maverick-17b-128e-instruct": 128000,
  "meta/llama-4-scout-17b-16e-instruct": 128000,
  "meta/llama3-70b-instruct": 8192,
  "meta/llama3-8b-instruct": 8192,

  // DeepSeek
  "deepseek-ai/deepseek-v3.2": 160000,
  "deepseek-ai/deepseek-v3.1": 128000,
  "deepseek-ai/deepseek-v3.1-terminus": 160000,
  "deepseek-ai/deepseek-r1-distill-qwen-32b": 128000,
  "deepseek-ai/deepseek-r1-distill-qwen-14b": 128000,
  "deepseek-ai/deepseek-r1-distill-qwen-7b": 128000,
  "deepseek-ai/deepseek-r1-distill-llama-8b": 128000,

  // Qwen
  "qwen/qwen3-235b-a22b": 128000,
  "qwen/qwen3-coder-480b-a35b-instruct": 256000,
  "qwen/qwen3-next-80b-a3b-instruct": 256000,
  "qwen/qwen3-next-80b-a3b-thinking": 256000,
  "qwen/qwq-32b": 128000,
  "qwen/qwen2.5-coder-32b-instruct": 32000,
  "qwen/qwen2.5-7b-instruct": 32000,

  // Mistral
  "mistralai/mistral-large-3-675b-instruct-2512": 128000,
  "mistralai/mistral-large-2-instruct": 128000,
  "mistralai/mistral-medium-3-instruct": 128000,
  "mistralai/devstral-2-123b-instruct-2512": 128000,
  "mistralai/mixtral-8x22b-instruct-v0.1": 64000,
  "mistralai/mixtral-8x7b-instruct-v0.1": 32000,

  // Kimi
  "moonshotai/kimi-k2.5": 256000,
  "moonshotai/kimi-k2-instruct": 256000,
  "moonshotai/kimi-k2-instruct-0905": 256000,
  "moonshotai/kimi-k2-thinking": 256000,

  // MiniMax
  "minimaxai/minimax-m2.1": 200000,
  "minimaxai/minimax-m2": 200000,

  // NVIDIA Nemotron
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": 128000,
  "nvidia/llama-3.1-nemotron-70b-instruct": 128000,
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": 128000,
  "nvidia/llama-3.3-nemotron-super-49b-v1": 128000,

  // Microsoft Phi
  "microsoft/phi-4-mini-instruct": 128000,
  "microsoft/phi-4-multimodal-instruct": 128000,
  "microsoft/phi-3-medium-128k-instruct": 128000,

  // Google Gemma
  "google/gemma-3-27b-it": 128000,
  "google/gemma-3-12b-it": 128000,
  "google/gemma-2-27b-it": 8192,
  "google/gemma-2-9b-it": 8192,

  // GLM
  "z-ai/glm4.7": 128000,

  // IBM Granite
  "ibm/granite-3.3-8b-instruct": 128000,

  // ByteDance Seed
  "bytedance/seed-oss-36b-instruct": 256000,
};

function getDefaultContextWindow(modelId: string): number {
  return MODEL_CONTEXT_WINDOWS[modelId] ?? 128000;
}

const MODEL_MAX_TOKENS: Record<string, number> = {
  // Most models default to 16384
  "meta/llama-3.3-70b-instruct": 16384,
  "meta/llama-3.1-405b-instruct": 16384,
  "deepseek-ai/deepseek-v3.2": 16384,
  "deepseek-ai/deepseek-v3.1": 16384,
  "qwen/qwen3-coder-480b-a35b-instruct": 16384,
  "mistralai/mistral-large-3-675b-instruct-2512": 16384,
  "moonshotai/kimi-k2.5": 8192,
  "minimaxai/minimax-m2.1": 16384,
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": 16384,
  "z-ai/glm4.7": 131072,
};

function getDefaultMaxTokens(modelId: string): number {
  return MODEL_MAX_TOKENS[modelId] ?? 16384;
}

const MODEL_NAMES: Record<string, string> = {
  // Meta Llama
  "meta/llama-3.3-70b-instruct": "Llama 3.3 70B",
  "meta/llama-3.1-405b-instruct": "Llama 3.1 405B",
  "meta/llama-3.1-70b-instruct": "Llama 3.1 70B",
  "meta/llama-3.1-8b-instruct": "Llama 3.1 8B",
  "meta/llama-3.2-90b-vision-instruct": "Llama 3.2 90B Vision",
  "meta/llama-3.2-11b-vision-instruct": "Llama 3.2 11B Vision",
  "meta/llama-4-maverick-17b-128e-instruct": "Llama 4 Maverick 17B",
  "meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout 17B",
  "meta/llama3-70b-instruct": "Llama 3 70B",
  "meta/llama3-8b-instruct": "Llama 3 8B",

  // DeepSeek
  "deepseek-ai/deepseek-v3.2": "DeepSeek V3.2",
  "deepseek-ai/deepseek-v3.1": "DeepSeek V3.1",
  "deepseek-ai/deepseek-v3.1-terminus": "DeepSeek V3.1 Terminus",
  "deepseek-ai/deepseek-r1-distill-qwen-32b": "DeepSeek R1 Distill 32B",
  "deepseek-ai/deepseek-r1-distill-qwen-14b": "DeepSeek R1 Distill 14B",
  "deepseek-ai/deepseek-r1-distill-qwen-7b": "DeepSeek R1 Distill 7B",
  "deepseek-ai/deepseek-r1-distill-llama-8b": "DeepSeek R1 Distill Llama 8B",
  "deepseek-ai/deepseek-coder-6.7b-instruct": "DeepSeek Coder 6.7B",

  // Qwen
  "qwen/qwen3-235b-a22b": "Qwen3 235B",
  "qwen/qwen3-coder-480b-a35b-instruct": "Qwen3 Coder 480B",
  "qwen/qwen3-next-80b-a3b-instruct": "Qwen3 Next 80B",
  "qwen/qwen3-next-80b-a3b-thinking": "Qwen3 Next 80B Thinking",
  "qwen/qwq-32b": "QwQ 32B",
  "qwen/qwen2.5-coder-32b-instruct": "Qwen2.5 Coder 32B",
  "qwen/qwen2.5-coder-7b-instruct": "Qwen2.5 Coder 7B",
  "qwen/qwen2.5-7b-instruct": "Qwen2.5 7B",
  "qwen/qwen2-7b-instruct": "Qwen2 7B",

  // Mistral
  "mistralai/mistral-large-3-675b-instruct-2512": "Mistral Large 3 675B",
  "mistralai/mistral-large-2-instruct": "Mistral Large 2",
  "mistralai/mistral-large": "Mistral Large",
  "mistralai/mistral-medium-3-instruct": "Mistral Medium 3",
  "mistralai/devstral-2-123b-instruct-2512": "Devstral 2 123B",
  "mistralai/magistral-small-2506": "Magistral Small",
  "mistralai/mixtral-8x22b-instruct-v0.1": "Mixtral 8x22B",
  "mistralai/mixtral-8x7b-instruct-v0.1": "Mixtral 8x7B",
  "mistralai/codestral-22b-instruct-v0.1": "Codestral 22B",
  "mistralai/mistral-small-3.1-24b-instruct-2503": "Mistral Small 3.1 24B",
  "mistralai/mistral-nemotron": "Mistral Nemotron",

  // Kimi
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  "moonshotai/kimi-k2-instruct": "Kimi K2",
  "moonshotai/kimi-k2-instruct-0905": "Kimi K2 0905",
  "moonshotai/kimi-k2-thinking": "Kimi K2 Thinking",

  // MiniMax
  "minimaxai/minimax-m2.1": "MiniMax M2.1",
  "minimaxai/minimax-m2": "MiniMax M2",

  // NVIDIA Nemotron
  "nvidia/llama-3.1-nemotron-ultra-253b-v1": "Nemotron Ultra 253B",
  "nvidia/llama-3.1-nemotron-70b-instruct": "Nemotron 70B",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": "Nemotron Super 49B v1.5",
  "nvidia/llama-3.3-nemotron-super-49b-v1": "Nemotron Super 49B",
  "nvidia/llama-3.1-nemotron-51b-instruct": "Nemotron 51B",
  "nvidia/nemotron-4-340b-instruct": "Nemotron 4 340B",
  "nvidia/cosmos-reason2-8b": "Cosmos Reason2 8B",

  // Microsoft Phi
  "microsoft/phi-4-mini-instruct": "Phi-4 Mini",
  "microsoft/phi-4-mini-flash-reasoning": "Phi-4 Mini Flash Reasoning",
  "microsoft/phi-4-multimodal-instruct": "Phi-4 Multimodal",
  "microsoft/phi-3.5-moe-instruct": "Phi-3.5 MoE",
  "microsoft/phi-3-medium-128k-instruct": "Phi-3 Medium 128K",
  "microsoft/phi-3-vision-128k-instruct": "Phi-3 Vision 128K",
  "microsoft/phi-3.5-vision-instruct": "Phi-3.5 Vision",

  // Google Gemma
  "google/gemma-3-27b-it": "Gemma 3 27B",
  "google/gemma-3-12b-it": "Gemma 3 12B",
  "google/gemma-3-4b-it": "Gemma 3 4B",
  "google/gemma-2-27b-it": "Gemma 2 27B",
  "google/gemma-2-9b-it": "Gemma 2 9B",
  "google/codegemma-7b": "CodeGemma 7B",

  // GLM
  "z-ai/glm4.7": "GLM-4.7",

  // IBM Granite
  "ibm/granite-3.3-8b-instruct": "Granite 3.3 8B",
  "ibm/granite-3.0-8b-instruct": "Granite 3.0 8B",
  "ibm/granite-34b-code-instruct": "Granite 34B Code",

  // ByteDance Seed
  "bytedance/seed-oss-36b-instruct": "Seed OSS 36B",

  // Others
  "01-ai/yi-large": "Yi Large",
  "thudm/chatglm3-6b": "ChatGLM3 6B",
};

function formatModelName(modelId: string): string {
  if (MODEL_NAMES[modelId]) {
    return MODEL_NAMES[modelId];
  }
  // Extract the model name from the full ID
  const parts = modelId.split("/");
  const name = parts[parts.length - 1];
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Build a ModelDefinitionConfig from a model ID.
 */
function buildModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: formatModelName(modelId),
    api: resolveNvidiaModelApi(modelId),
    reasoning: supportsReasoning(modelId),
    input: supportsImageInput(modelId) ? ["text", "image"] : ["text"],
    cost: DEFAULT_COST,
    contextWindow: getDefaultContextWindow(modelId),
    maxTokens: getDefaultMaxTokens(modelId),
  };
}

/**
 * Static fallback models for NVIDIA NIM.
 * Selected from the most useful/popular models.
 */
export function getNvidiaStaticFallbackModels(): ModelDefinitionConfig[] {
  const modelIds = [
    // === Meta Llama ===
    "meta/llama-3.3-70b-instruct",
    "meta/llama-3.1-405b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "meta/llama-3.2-90b-vision-instruct",
    "meta/llama-3.2-11b-vision-instruct",
    "meta/llama-4-maverick-17b-128e-instruct",
    "meta/llama-4-scout-17b-16e-instruct",
    "meta/llama3-70b-instruct",
    "meta/llama3-8b-instruct",

    // === DeepSeek ===
    "deepseek-ai/deepseek-v3.2",
    "deepseek-ai/deepseek-v3.1",
    "deepseek-ai/deepseek-v3.1-terminus",
    "deepseek-ai/deepseek-r1-distill-qwen-32b",
    "deepseek-ai/deepseek-r1-distill-qwen-14b",
    "deepseek-ai/deepseek-r1-distill-qwen-7b",
    "deepseek-ai/deepseek-r1-distill-llama-8b",
    "deepseek-ai/deepseek-coder-6.7b-instruct",

    // === Qwen ===
    "qwen/qwen3-235b-a22b",
    "qwen/qwen3-coder-480b-a35b-instruct",
    "qwen/qwen3-next-80b-a3b-instruct",
    "qwen/qwen3-next-80b-a3b-thinking",
    "qwen/qwq-32b",
    "qwen/qwen2.5-coder-32b-instruct",
    "qwen/qwen2.5-coder-7b-instruct",
    "qwen/qwen2.5-7b-instruct",
    "qwen/qwen2-7b-instruct",

    // === Mistral ===
    "mistralai/mistral-large-3-675b-instruct-2512",
    "mistralai/mistral-large-2-instruct",
    "mistralai/mistral-medium-3-instruct",
    "mistralai/devstral-2-123b-instruct-2512",
    "mistralai/magistral-small-2506",
    "mistralai/mixtral-8x22b-instruct-v0.1",
    "mistralai/mixtral-8x7b-instruct-v0.1",
    "mistralai/codestral-22b-instruct-v0.1",
    "mistralai/mistral-small-3.1-24b-instruct-2503",
    "mistralai/mistral-nemotron",

    // === Kimi (Moonshot) ===
    "moonshotai/kimi-k2.5",
    "moonshotai/kimi-k2-instruct",
    "moonshotai/kimi-k2-instruct-0905",
    "moonshotai/kimi-k2-thinking",

    // === MiniMax ===
    "minimaxai/minimax-m2.1",
    "minimaxai/minimax-m2",

    // === NVIDIA Nemotron ===
    "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "nvidia/llama-3.3-nemotron-super-49b-v1",
    "nvidia/llama-3.1-nemotron-51b-instruct",
    "nvidia/nemotron-4-340b-instruct",
    "nvidia/cosmos-reason2-8b",

    // === Microsoft Phi ===
    "microsoft/phi-4-mini-instruct",
    "microsoft/phi-4-mini-flash-reasoning",
    "microsoft/phi-4-multimodal-instruct",
    "microsoft/phi-3.5-moe-instruct",
    "microsoft/phi-3-medium-128k-instruct",
    "microsoft/phi-3-vision-128k-instruct",
    "microsoft/phi-3.5-vision-instruct",

    // === Google Gemma ===
    "google/gemma-3-27b-it",
    "google/gemma-3-12b-it",
    "google/gemma-3-4b-it",
    "google/gemma-2-27b-it",
    "google/gemma-2-9b-it",
    "google/codegemma-7b",

    // === GLM (Z.AI) ===
    "z-ai/glm4.7",

    // === IBM Granite ===
    "ibm/granite-3.3-8b-instruct",
    "ibm/granite-3.0-8b-instruct",
    "ibm/granite-34b-code-instruct",

    // === ByteDance Seed ===
    "bytedance/seed-oss-36b-instruct",

    // === Others ===
    "01-ai/yi-large",
    "thudm/chatglm3-6b",
  ];

  return modelIds.map(buildModelDefinition);
}

/**
 * Build the NVIDIA provider configuration.
 */
export function buildNvidiaProvider(apiKey?: string): {
  baseUrl: string;
  api: ModelApi;
  apiKey?: string;
  models: ModelDefinitionConfig[];
} {
  return {
    baseUrl: NVIDIA_API_BASE_URL,
    api: "openai-completions",
    ...(apiKey ? { apiKey } : {}),
    models: getNvidiaStaticFallbackModels(),
  };
}
