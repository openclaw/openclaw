/**
 * SiliconFlow (硅基流动) model catalog with dynamic fetching, caching, and static fallback.
 *
 * SiliconFlow provides access to multiple AI models through an OpenAI-compatible API.
 *
 * API endpoint: https://api.siliconflow.cn/v1
 * Documentation: https://docs.siliconflow.cn/
 */

import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";

export const SILICONFLOW_API_BASE_URL = "https://api.siliconflow.cn/v1";
export const SILICONFLOW_DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3.2";
export const SILICONFLOW_DEFAULT_MODEL_REF = `siliconflow/${SILICONFLOW_DEFAULT_MODEL.replace("/", "-")}`;

// Cache for fetched models (1 hour TTL)
let cachedModels: ModelDefinitionConfig[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Model aliases for convenient shortcuts.
 * Users can use "deepseek" instead of "deepseek-ai/DeepSeek-V3.2", etc.
 */
export const SILICONFLOW_MODEL_ALIASES: Record<string, string> = {
  // DeepSeek
  deepseek: "deepseek-ai/DeepSeek-V3.2",
  "deepseek-v3": "deepseek-ai/DeepSeek-V3",
  "deepseek-v3.2": "deepseek-ai/DeepSeek-V3.2",
  "deepseek-r1": "deepseek-ai/DeepSeek-R1",
  "deepseek-terminus": "deepseek-ai/DeepSeek-V3.1-Terminus",

  // Kimi
  kimi: "Pro/moonshotai/Kimi-K2.5",
  "kimi-k2": "Pro/moonshotai/Kimi-K2.5",
  "kimi-k2.5": "Pro/moonshotai/Kimi-K2.5",
  "kimi-thinking": "Pro/moonshotai/Kimi-K2-Thinking",
  "kimi-dev": "moonshotai/Kimi-Dev-72B",

  // GLM
  glm: "Pro/zai-org/GLM-4.7",
  "glm-4.7": "Pro/zai-org/GLM-4.7",
  "glm-4.6": "zai-org/GLM-4.6",
  "glm-4.6v": "zai-org/GLM-4.6V",
  "glm-4.5": "zai-org/GLM-4.5-Air",
  "glm-z1": "THUDM/GLM-Z1-32B-0414",
  "glm-rumination": "THUDM/GLM-Z1-Rumination-32B-0414",

  // Qwen3
  qwen: "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "qwen3": "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "qwen3-coder": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
  "qwen3-32b": "Qwen/Qwen3-32B",
  "qwen3-14b": "Qwen/Qwen3-14B",
  "qwen3-8b": "Qwen/Qwen3-8B",
  "qwen3-thinking": "Qwen/Qwen3-235B-A22B-Thinking-2507",
  "qwen3-vl": "Qwen/Qwen3-VL-235B-A22B-Instruct",

  // Qwen2.5
  "qwen2.5": "Qwen/Qwen2.5-72B-Instruct",
  "qwen2.5-72b": "Qwen/Qwen2.5-72B-Instruct",
  "qwen2.5-32b": "Qwen/Qwen2.5-32B-Instruct",
  "qwen2.5-coder": "Qwen/Qwen2.5-Coder-32B-Instruct",
  "qwq": "Qwen/QwQ-32B",

  // MiniMax
  minimax: "Pro/MiniMaxAI/MiniMax-M2.1",
  "minimax-m2": "MiniMaxAI/MiniMax-M2",
  "minimax-m2.1": "Pro/MiniMaxAI/MiniMax-M2.1",
  "minimax-m1": "MiniMaxAI/MiniMax-M1-80k",

  // Others
  step3: "stepfun-ai/step3",
  ernie: "baidu/ERNIE-4.5-300B-A47B",
  hunyuan: "tencent/Hunyuan-A13B-Instruct",
  ling: "inclusionAI/Ling-flash-2.0",
  ring: "inclusionAI/Ring-flash-2.0",
  pangu: "ascend-tribe/pangu-pro-moe",
  seed: "ByteDance-Seed/Seed-OSS-36B-Instruct",
};

/**
 * Resolve a model alias to its full model ID.
 * Returns the input if no alias exists.
 */
export function resolveSiliconFlowAlias(modelIdOrAlias: string): string {
  const normalized = modelIdOrAlias.toLowerCase().trim();
  return SILICONFLOW_MODEL_ALIASES[normalized] ?? modelIdOrAlias;
}

/**
 * SiliconFlow uses OpenAI-compatible API for all models.
 */
export function resolveSiliconFlowModelApi(_modelId: string): ModelApi {
  return "openai-completions";
}

/**
 * Check if a model supports image input.
 */
function supportsImageInput(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("-vl") ||
    lower.includes("-vl-") ||
    lower.includes("vision") ||
    lower.includes("qvq") ||
    lower.includes("step3") ||
    lower.includes("glm-4.6v") ||
    lower.includes("glm-4.5v") ||
    lower.includes("paddleocr") ||
    lower.includes("deepseek-ocr") ||
    lower.includes("omni")
  );
}

/**
 * Check if a model supports reasoning/thinking.
 */
function supportsReasoning(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("thinking") ||
    lower.includes("deepseek-r1") ||
    lower.includes("qwq") ||
    lower.includes("glm-z1") ||
    lower.includes("rumination") ||
    lower.includes("ring-") ||
    lower.includes("qwenlong")
  );
}

// Cost per million tokens (in CNY, converted to approximate USD)
// Using approximate rate: 1 CNY ≈ 0.14 USD
const MODEL_COSTS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  // Free models (zero cost)
  "Qwen/Qwen3-8B": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "Qwen/Qwen2.5-7B-Instruct": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "Qwen/Qwen2.5-Coder-7B-Instruct": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "THUDM/glm-4-9b-chat": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "internlm/internlm2_5-7b-chat": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "Qwen/Qwen2-7B-Instruct": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "THUDM/GLM-4.1V-9B-Thinking": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "THUDM/GLM-Z1-9B-0414": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "THUDM/GLM-4-9B-0414": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "PaddlePaddle/PaddleOCR-VL-1.5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "PaddlePaddle/PaddleOCR-VL": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "deepseek-ai/DeepSeek-OCR": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "tencent/Hunyuan-MT-7B": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

  // DeepSeek models (CNY/M tokens -> approx USD)
  "deepseek-ai/DeepSeek-V3.2": { input: 0.42, output: 0.42, cacheRead: 0.04, cacheWrite: 0 },
  "Pro/deepseek-ai/DeepSeek-V3.2": { input: 0.42, output: 0.42, cacheRead: 0.04, cacheWrite: 0 },
  "deepseek-ai/DeepSeek-V3.1-Terminus": { input: 1.68, output: 1.68, cacheRead: 0.17, cacheWrite: 0 },
  "Pro/deepseek-ai/DeepSeek-V3.1-Terminus": { input: 1.68, output: 1.68, cacheRead: 0.17, cacheWrite: 0 },
  "deepseek-ai/DeepSeek-R1": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },
  "Pro/deepseek-ai/DeepSeek-R1": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },
  "deepseek-ai/DeepSeek-V3": { input: 1.12, output: 1.12, cacheRead: 0.11, cacheWrite: 0 },
  "Pro/deepseek-ai/DeepSeek-V3": { input: 1.12, output: 1.12, cacheRead: 0.11, cacheWrite: 0 },

  // Kimi models
  "Pro/moonshotai/Kimi-K2.5": { input: 2.94, output: 2.94, cacheRead: 0.29, cacheWrite: 0 },
  "moonshotai/Kimi-K2-Thinking": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },
  "Pro/moonshotai/Kimi-K2-Thinking": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },
  "moonshotai/Kimi-K2-Instruct-0905": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },
  "Pro/moonshotai/Kimi-K2-Instruct-0905": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },
  "moonshotai/Kimi-Dev-72B": { input: 1.12, output: 1.12, cacheRead: 0.11, cacheWrite: 0 },

  // GLM models
  "Pro/zai-org/GLM-4.7": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },
  "zai-org/GLM-4.6": { input: 1.96, output: 1.96, cacheRead: 0.2, cacheWrite: 0 },
  "zai-org/GLM-4.6V": { input: 0.42, output: 0.42, cacheRead: 0.04, cacheWrite: 0 },
  "zai-org/GLM-4.5V": { input: 0.84, output: 0.84, cacheRead: 0.08, cacheWrite: 0 },
  "zai-org/GLM-4.5-Air": { input: 0.84, output: 0.84, cacheRead: 0.08, cacheWrite: 0 },
  "THUDM/GLM-Z1-32B-0414": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "THUDM/GLM-4-32B-0414": { input: 0.26, output: 0.26, cacheRead: 0.03, cacheWrite: 0 },
  "THUDM/GLM-Z1-Rumination-32B-0414": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "Pro/THUDM/GLM-4.1V-9B-Thinking": { input: 0.14, output: 0.14, cacheRead: 0.01, cacheWrite: 0 },

  // MiniMax models
  "Pro/MiniMaxAI/MiniMax-M2.1": { input: 1.18, output: 1.18, cacheRead: 0.12, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M2": { input: 1.18, output: 1.18, cacheRead: 0.12, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M1-80k": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },

  // Qwen3 models
  "Qwen/Qwen3-235B-A22B-Instruct-2507": { input: 1.4, output: 1.4, cacheRead: 0.14, cacheWrite: 0 },
  "Qwen/Qwen3-235B-A22B-Thinking-2507": { input: 1.4, output: 1.4, cacheRead: 0.14, cacheWrite: 0 },
  "Qwen/Qwen3-30B-A3B-Instruct-2507": { input: 0.39, output: 0.39, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3-30B-A3B-Thinking-2507": { input: 0.39, output: 0.39, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3-Coder-480B-A35B-Instruct": { input: 2.24, output: 2.24, cacheRead: 0.22, cacheWrite: 0 },
  "Qwen/Qwen3-Coder-30B-A3B-Instruct": { input: 0.39, output: 0.39, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3-VL-235B-A22B-Instruct": { input: 1.4, output: 1.4, cacheRead: 0.14, cacheWrite: 0 },
  "Qwen/Qwen3-VL-235B-A22B-Thinking": { input: 1.4, output: 1.4, cacheRead: 0.14, cacheWrite: 0 },
  "Qwen/Qwen3-VL-32B-Instruct": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "Qwen/Qwen3-VL-32B-Thinking": { input: 1.4, output: 1.4, cacheRead: 0.14, cacheWrite: 0 },
  "Qwen/Qwen3-VL-30B-A3B-Instruct": { input: 0.39, output: 0.39, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3-VL-30B-A3B-Thinking": { input: 0.39, output: 0.39, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3-VL-8B-Instruct": { input: 0.28, output: 0.28, cacheRead: 0.03, cacheWrite: 0 },
  "Qwen/Qwen3-VL-8B-Thinking": { input: 0.7, output: 0.7, cacheRead: 0.07, cacheWrite: 0 },
  "Qwen/Qwen3-Omni-30B-A3B-Instruct": { input: 0.39, output: 0.39, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3-Omni-30B-A3B-Thinking": { input: 0.39, output: 0.39, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3-Next-80B-A3B-Instruct": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "Qwen/Qwen3-Next-80B-A3B-Thinking": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "Qwen/Qwen3-30B-A3B": { input: 0.39, output: 0.39, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3-32B": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "Qwen/Qwen3-14B": { input: 0.28, output: 0.28, cacheRead: 0.03, cacheWrite: 0 },

  // Qwen2.5 models
  "Qwen/Qwen2.5-72B-Instruct": { input: 0.58, output: 0.58, cacheRead: 0.06, cacheWrite: 0 },
  "Qwen/Qwen2.5-72B-Instruct-128K": { input: 0.58, output: 0.58, cacheRead: 0.06, cacheWrite: 0 },
  "Qwen/Qwen2.5-32B-Instruct": { input: 0.18, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
  "Qwen/Qwen2.5-14B-Instruct": { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0 },
  "Qwen/Qwen2.5-Coder-32B-Instruct": { input: 0.18, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
  "Qwen/Qwen2.5-VL-72B-Instruct": { input: 0.58, output: 0.58, cacheRead: 0.06, cacheWrite: 0 },
  "Qwen/Qwen2.5-VL-32B-Instruct": { input: 0.26, output: 0.26, cacheRead: 0.03, cacheWrite: 0 },
  "Pro/Qwen/Qwen2.5-VL-7B-Instruct": { input: 0.05, output: 0.05, cacheRead: 0.01, cacheWrite: 0 },
  "Qwen/QwQ-32B": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "Qwen/QVQ-72B-Preview": { input: 1.39, output: 1.39, cacheRead: 0.14, cacheWrite: 0 },
  "Tongyi-Zhiwen/QwenLong-L1-32B": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },

  // DeepSeek Distill models
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B": { input: 0.18, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B": { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0 },
  "deepseek-ai/deepseek-vl2": { input: 0.14, output: 0.14, cacheRead: 0.01, cacheWrite: 0 },

  // Other models
  "stepfun-ai/step3": { input: 1.4, output: 1.4, cacheRead: 0.14, cacheWrite: 0 },
  "ByteDance-Seed/Seed-OSS-36B-Instruct": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "inclusionAI/Ring-flash-2.0": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "inclusionAI/Ling-flash-2.0": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "inclusionAI/Ling-mini-2.0": { input: 0.28, output: 0.28, cacheRead: 0.03, cacheWrite: 0 },
  "baidu/ERNIE-4.5-300B-A47B": { input: 1.12, output: 1.12, cacheRead: 0.11, cacheWrite: 0 },
  "tencent/Hunyuan-A13B-Instruct": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "ascend-tribe/pangu-pro-moe": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
  "Kwaipilot/KAT-Dev": { input: 0.56, output: 0.56, cacheRead: 0.06, cacheWrite: 0 },
};

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Free models
  "Qwen/Qwen3-8B": 128000,
  "Qwen/Qwen2.5-7B-Instruct": 32000,
  "Qwen/Qwen2.5-Coder-7B-Instruct": 32000,
  "THUDM/glm-4-9b-chat": 128000,
  "internlm/internlm2_5-7b-chat": 32000,
  "Qwen/Qwen2-7B-Instruct": 32000,
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B": 128000,
  "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B": 128000,
  "THUDM/GLM-4.1V-9B-Thinking": 64000,
  "THUDM/GLM-Z1-9B-0414": 128000,
  "THUDM/GLM-4-9B-0414": 32000,

  // DeepSeek models
  "deepseek-ai/DeepSeek-V3.2": 160000,
  "Pro/deepseek-ai/DeepSeek-V3.2": 160000,
  "deepseek-ai/DeepSeek-V3.1-Terminus": 160000,
  "Pro/deepseek-ai/DeepSeek-V3.1-Terminus": 160000,
  "deepseek-ai/DeepSeek-R1": 160000,
  "Pro/deepseek-ai/DeepSeek-R1": 160000,
  "deepseek-ai/DeepSeek-V3": 128000,
  "Pro/deepseek-ai/DeepSeek-V3": 128000,

  // Kimi models
  "Pro/moonshotai/Kimi-K2.5": 256000,
  "moonshotai/Kimi-K2-Thinking": 256000,
  "Pro/moonshotai/Kimi-K2-Thinking": 256000,
  "moonshotai/Kimi-K2-Instruct-0905": 256000,
  "Pro/moonshotai/Kimi-K2-Instruct-0905": 256000,
  "moonshotai/Kimi-Dev-72B": 128000,

  // GLM models
  "Pro/zai-org/GLM-4.7": 200000,
  "zai-org/GLM-4.6": 200000,
  "zai-org/GLM-4.6V": 128000,
  "zai-org/GLM-4.5V": 64000,
  "zai-org/GLM-4.5-Air": 128000,
  "THUDM/GLM-Z1-32B-0414": 128000,
  "THUDM/GLM-4-32B-0414": 32000,
  "THUDM/GLM-Z1-Rumination-32B-0414": 128000,
  "Pro/THUDM/GLM-4.1V-9B-Thinking": 64000,

  // MiniMax models
  "Pro/MiniMaxAI/MiniMax-M2.1": 200000,
  "MiniMaxAI/MiniMax-M2": 200000,
  "MiniMaxAI/MiniMax-M1-80k": 128000,

  // Qwen3 models
  "Qwen/Qwen3-235B-A22B-Instruct-2507": 256000,
  "Qwen/Qwen3-235B-A22B-Thinking-2507": 256000,
  "Qwen/Qwen3-30B-A3B-Instruct-2507": 256000,
  "Qwen/Qwen3-30B-A3B-Thinking-2507": 256000,
  "Qwen/Qwen3-Coder-480B-A35B-Instruct": 256000,
  "Qwen/Qwen3-Coder-30B-A3B-Instruct": 256000,
  "Qwen/Qwen3-VL-235B-A22B-Instruct": 256000,
  "Qwen/Qwen3-VL-235B-A22B-Thinking": 256000,
  "Qwen/Qwen3-VL-32B-Instruct": 256000,
  "Qwen/Qwen3-VL-32B-Thinking": 256000,
  "Qwen/Qwen3-VL-30B-A3B-Instruct": 256000,
  "Qwen/Qwen3-VL-30B-A3B-Thinking": 256000,
  "Qwen/Qwen3-VL-8B-Instruct": 256000,
  "Qwen/Qwen3-VL-8B-Thinking": 256000,
  "Qwen/Qwen3-Omni-30B-A3B-Instruct": 64000,
  "Qwen/Qwen3-Omni-30B-A3B-Thinking": 64000,
  "Qwen/Qwen3-Next-80B-A3B-Instruct": 256000,
  "Qwen/Qwen3-Next-80B-A3B-Thinking": 256000,
  "Qwen/Qwen3-30B-A3B": 128000,
  "Qwen/Qwen3-32B": 128000,
  "Qwen/Qwen3-14B": 128000,

  // Qwen2.5 models
  "Qwen/Qwen2.5-72B-Instruct": 32000,
  "Qwen/Qwen2.5-72B-Instruct-128K": 128000,
  "Qwen/Qwen2.5-32B-Instruct": 32000,
  "Qwen/Qwen2.5-14B-Instruct": 32000,
  "Qwen/Qwen2.5-Coder-32B-Instruct": 32000,
  "Qwen/Qwen2.5-VL-72B-Instruct": 128000,
  "Qwen/Qwen2.5-VL-32B-Instruct": 128000,
  "Pro/Qwen/Qwen2.5-VL-7B-Instruct": 32000,
  "Qwen/QwQ-32B": 128000,
  "Qwen/QVQ-72B-Preview": 32000,
  "Tongyi-Zhiwen/QwenLong-L1-32B": 128000,

  // DeepSeek Distill models
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B": 128000,
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B": 128000,
  "deepseek-ai/deepseek-vl2": 4000,

  // Other models
  "stepfun-ai/step3": 64000,
  "ByteDance-Seed/Seed-OSS-36B-Instruct": 256000,
  "inclusionAI/Ring-flash-2.0": 128000,
  "inclusionAI/Ling-flash-2.0": 128000,
  "inclusionAI/Ling-mini-2.0": 128000,
  "baidu/ERNIE-4.5-300B-A47B": 128000,
  "tencent/Hunyuan-A13B-Instruct": 128000,
  "tencent/Hunyuan-MT-7B": 32000,
  "ascend-tribe/pangu-pro-moe": 128000,
  "Kwaipilot/KAT-Dev": 128000,
};

function getDefaultContextWindow(modelId: string): number {
  return MODEL_CONTEXT_WINDOWS[modelId] ?? 128000;
}

const MODEL_MAX_TOKENS: Record<string, number> = {
  // Most models default to 8192
  "Qwen/Qwen3-8B": 8192,
  "Qwen/Qwen3-14B": 8192,
  "Qwen/Qwen3-32B": 8192,
  "Qwen/Qwen3-30B-A3B": 8192,
  
  // GLM models have high max tokens
  "THUDM/glm-4-9b-chat": 131072,
  "THUDM/GLM-Z1-9B-0414": 16384,
  "THUDM/GLM-4-9B-0414": 16384,
  "THUDM/GLM-Z1-32B-0414": 16384,
  "THUDM/GLM-4-32B-0414": 16384,
  "Pro/zai-org/GLM-4.7": 131072,
  "zai-org/GLM-4.6": 16384,

  // DeepSeek models
  "deepseek-ai/DeepSeek-V3.2": 16384,
  "deepseek-ai/DeepSeek-V3": 16384,
  "deepseek-ai/DeepSeek-R1": 16384,

  // Kimi models
  "Pro/moonshotai/Kimi-K2.5": 8192,
  "moonshotai/Kimi-K2-Thinking": 8192,
  
  // Qwen3 Coder
  "Qwen/Qwen3-Coder-480B-A35B-Instruct": 16384,
  "Qwen/Qwen3-Coder-30B-A3B-Instruct": 16384,
  
  // Qwen2.5
  "Qwen/Qwen2.5-Coder-32B-Instruct": 16384,
};

function getDefaultMaxTokens(modelId: string): number {
  return MODEL_MAX_TOKENS[modelId] ?? 8192;
}

const MODEL_NAMES: Record<string, string> = {
  // Free models
  "Qwen/Qwen3-8B": "Qwen3 8B",
  "Qwen/Qwen2.5-7B-Instruct": "Qwen2.5 7B Instruct",
  "Qwen/Qwen2.5-Coder-7B-Instruct": "Qwen2.5 Coder 7B",
  "THUDM/glm-4-9b-chat": "GLM-4 9B Chat",
  "internlm/internlm2_5-7b-chat": "InternLM2.5 7B Chat",
  "Qwen/Qwen2-7B-Instruct": "Qwen2 7B Instruct",
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B": "DeepSeek R1 Distill Qwen 7B",
  "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B": "DeepSeek R1 Qwen3 8B",
  "THUDM/GLM-4.1V-9B-Thinking": "GLM-4.1V 9B Thinking",
  "THUDM/GLM-Z1-9B-0414": "GLM-Z1 9B",
  "THUDM/GLM-4-9B-0414": "GLM-4 9B",
  "PaddlePaddle/PaddleOCR-VL-1.5": "PaddleOCR-VL 1.5",
  "PaddlePaddle/PaddleOCR-VL": "PaddleOCR-VL",
  "deepseek-ai/DeepSeek-OCR": "DeepSeek OCR",
  "tencent/Hunyuan-MT-7B": "Hunyuan MT 7B (翻译)",

  // DeepSeek models
  "deepseek-ai/DeepSeek-V3.2": "DeepSeek V3.2",
  "Pro/deepseek-ai/DeepSeek-V3.2": "DeepSeek V3.2 Pro",
  "deepseek-ai/DeepSeek-V3.1-Terminus": "DeepSeek V3.1 Terminus",
  "Pro/deepseek-ai/DeepSeek-V3.1-Terminus": "DeepSeek V3.1 Terminus Pro",
  "deepseek-ai/DeepSeek-R1": "DeepSeek R1",
  "Pro/deepseek-ai/DeepSeek-R1": "DeepSeek R1 Pro",
  "deepseek-ai/DeepSeek-V3": "DeepSeek V3",
  "Pro/deepseek-ai/DeepSeek-V3": "DeepSeek V3 Pro",

  // Kimi models
  "Pro/moonshotai/Kimi-K2.5": "Kimi K2.5 Pro",
  "moonshotai/Kimi-K2-Thinking": "Kimi K2 Thinking",
  "Pro/moonshotai/Kimi-K2-Thinking": "Kimi K2 Thinking Pro",
  "moonshotai/Kimi-K2-Instruct-0905": "Kimi K2 Instruct",
  "Pro/moonshotai/Kimi-K2-Instruct-0905": "Kimi K2 Instruct Pro",
  "moonshotai/Kimi-Dev-72B": "Kimi Dev 72B",

  // GLM models
  "Pro/zai-org/GLM-4.7": "GLM-4.7 Pro",
  "zai-org/GLM-4.6": "GLM-4.6",
  "zai-org/GLM-4.6V": "GLM-4.6V (视觉)",
  "zai-org/GLM-4.5V": "GLM-4.5V (视觉)",
  "zai-org/GLM-4.5-Air": "GLM-4.5 Air",
  "THUDM/GLM-Z1-32B-0414": "GLM-Z1 32B",
  "THUDM/GLM-4-32B-0414": "GLM-4 32B",
  "THUDM/GLM-Z1-Rumination-32B-0414": "GLM-Z1 Rumination 32B",
  "Pro/THUDM/GLM-4.1V-9B-Thinking": "GLM-4.1V 9B Thinking Pro",

  // MiniMax models
  "Pro/MiniMaxAI/MiniMax-M2.1": "MiniMax M2.1 Pro",
  "MiniMaxAI/MiniMax-M2": "MiniMax M2",
  "MiniMaxAI/MiniMax-M1-80k": "MiniMax M1 80K",

  // Qwen3 models
  "Qwen/Qwen3-235B-A22B-Instruct-2507": "Qwen3 235B Instruct",
  "Qwen/Qwen3-235B-A22B-Thinking-2507": "Qwen3 235B Thinking",
  "Qwen/Qwen3-30B-A3B-Instruct-2507": "Qwen3 30B Instruct",
  "Qwen/Qwen3-30B-A3B-Thinking-2507": "Qwen3 30B Thinking",
  "Qwen/Qwen3-Coder-480B-A35B-Instruct": "Qwen3 Coder 480B",
  "Qwen/Qwen3-Coder-30B-A3B-Instruct": "Qwen3 Coder 30B",
  "Qwen/Qwen3-VL-235B-A22B-Instruct": "Qwen3 VL 235B Instruct",
  "Qwen/Qwen3-VL-235B-A22B-Thinking": "Qwen3 VL 235B Thinking",
  "Qwen/Qwen3-VL-32B-Instruct": "Qwen3 VL 32B Instruct",
  "Qwen/Qwen3-VL-32B-Thinking": "Qwen3 VL 32B Thinking",
  "Qwen/Qwen3-VL-30B-A3B-Instruct": "Qwen3 VL 30B Instruct",
  "Qwen/Qwen3-VL-30B-A3B-Thinking": "Qwen3 VL 30B Thinking",
  "Qwen/Qwen3-VL-8B-Instruct": "Qwen3 VL 8B Instruct",
  "Qwen/Qwen3-VL-8B-Thinking": "Qwen3 VL 8B Thinking",
  "Qwen/Qwen3-Omni-30B-A3B-Instruct": "Qwen3 Omni 30B Instruct",
  "Qwen/Qwen3-Omni-30B-A3B-Thinking": "Qwen3 Omni 30B Thinking",
  "Qwen/Qwen3-Next-80B-A3B-Instruct": "Qwen3 Next 80B Instruct",
  "Qwen/Qwen3-Next-80B-A3B-Thinking": "Qwen3 Next 80B Thinking",
  "Qwen/Qwen3-30B-A3B": "Qwen3 30B MoE",
  "Qwen/Qwen3-32B": "Qwen3 32B",
  "Qwen/Qwen3-14B": "Qwen3 14B",

  // Qwen2.5 models
  "Qwen/Qwen2.5-72B-Instruct": "Qwen2.5 72B Instruct",
  "Qwen/Qwen2.5-72B-Instruct-128K": "Qwen2.5 72B 128K",
  "Qwen/Qwen2.5-32B-Instruct": "Qwen2.5 32B Instruct",
  "Qwen/Qwen2.5-14B-Instruct": "Qwen2.5 14B Instruct",
  "Qwen/Qwen2.5-Coder-32B-Instruct": "Qwen2.5 Coder 32B",
  "Qwen/Qwen2.5-VL-72B-Instruct": "Qwen2.5 VL 72B",
  "Qwen/Qwen2.5-VL-32B-Instruct": "Qwen2.5 VL 32B",
  "Pro/Qwen/Qwen2.5-VL-7B-Instruct": "Qwen2.5 VL 7B Pro",
  "Qwen/QwQ-32B": "QwQ 32B",
  "Qwen/QVQ-72B-Preview": "QVQ 72B Preview",
  "Tongyi-Zhiwen/QwenLong-L1-32B": "QwenLong L1 32B",

  // DeepSeek Distill models
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B": "DeepSeek R1 Distill 32B",
  "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B": "DeepSeek R1 Distill 14B",
  "deepseek-ai/deepseek-vl2": "DeepSeek VL2",

  // Other models
  "stepfun-ai/step3": "Step3 (阶跃)",
  "ByteDance-Seed/Seed-OSS-36B-Instruct": "Seed OSS 36B",
  "inclusionAI/Ring-flash-2.0": "Ring Flash 2.0",
  "inclusionAI/Ling-flash-2.0": "Ling Flash 2.0",
  "inclusionAI/Ling-mini-2.0": "Ling Mini 2.0",
  "baidu/ERNIE-4.5-300B-A47B": "ERNIE 4.5 300B",
  "tencent/Hunyuan-A13B-Instruct": "Hunyuan A13B",
  "ascend-tribe/pangu-pro-moe": "Pangu Pro MoE",
  "Kwaipilot/KAT-Dev": "KAT Dev (快手)",
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
    api: resolveSiliconFlowModelApi(modelId),
    reasoning: supportsReasoning(modelId),
    input: supportsImageInput(modelId) ? ["text", "image"] : ["text"],
    cost: MODEL_COSTS[modelId] ?? DEFAULT_COST,
    contextWindow: getDefaultContextWindow(modelId),
    maxTokens: getDefaultMaxTokens(modelId),
  };
}

/**
 * Static fallback models for SiliconFlow.
 * Includes both free and paid models.
 */
export function getSiliconFlowStaticFallbackModels(): ModelDefinitionConfig[] {
  const modelIds = [
    // === Free models ===
    "Qwen/Qwen3-8B",
    "Qwen/Qwen2.5-7B-Instruct",
    "Qwen/Qwen2.5-Coder-7B-Instruct",
    "THUDM/glm-4-9b-chat",
    "internlm/internlm2_5-7b-chat",
    "Qwen/Qwen2-7B-Instruct",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
    "THUDM/GLM-4.1V-9B-Thinking",
    "THUDM/GLM-Z1-9B-0414",
    "THUDM/GLM-4-9B-0414",
    "PaddlePaddle/PaddleOCR-VL-1.5",
    "deepseek-ai/DeepSeek-OCR",
    "tencent/Hunyuan-MT-7B",

    // === DeepSeek (性价比之王) ===
    "deepseek-ai/DeepSeek-V3.2",
    "Pro/deepseek-ai/DeepSeek-V3.2",
    "deepseek-ai/DeepSeek-V3",
    "Pro/deepseek-ai/DeepSeek-V3",
    "deepseek-ai/DeepSeek-R1",
    "Pro/deepseek-ai/DeepSeek-R1",
    "deepseek-ai/DeepSeek-V3.1-Terminus",
    "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B",
    "deepseek-ai/deepseek-vl2",

    // === Kimi (月之暗面) ===
    "Pro/moonshotai/Kimi-K2.5",
    "moonshotai/Kimi-K2-Thinking",
    "Pro/moonshotai/Kimi-K2-Thinking",
    "moonshotai/Kimi-K2-Instruct-0905",
    "Pro/moonshotai/Kimi-K2-Instruct-0905",
    "moonshotai/Kimi-Dev-72B",

    // === GLM (智谱) ===
    "Pro/zai-org/GLM-4.7",
    "zai-org/GLM-4.6",
    "zai-org/GLM-4.6V",
    "zai-org/GLM-4.5V",
    "zai-org/GLM-4.5-Air",
    "THUDM/GLM-Z1-32B-0414",
    "THUDM/GLM-4-32B-0414",
    "THUDM/GLM-Z1-Rumination-32B-0414",
    "Pro/THUDM/GLM-4.1V-9B-Thinking",

    // === MiniMax ===
    "Pro/MiniMaxAI/MiniMax-M2.1",
    "MiniMaxAI/MiniMax-M2",
    "MiniMaxAI/MiniMax-M1-80k",

    // === Qwen3 系列 (最新) ===
    "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "Qwen/Qwen3-235B-A22B-Thinking-2507",
    "Qwen/Qwen3-30B-A3B-Instruct-2507",
    "Qwen/Qwen3-30B-A3B-Thinking-2507",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    "Qwen/Qwen3-VL-235B-A22B-Instruct",
    "Qwen/Qwen3-VL-235B-A22B-Thinking",
    "Qwen/Qwen3-VL-32B-Instruct",
    "Qwen/Qwen3-VL-32B-Thinking",
    "Qwen/Qwen3-VL-30B-A3B-Instruct",
    "Qwen/Qwen3-VL-8B-Instruct",
    "Qwen/Qwen3-Omni-30B-A3B-Instruct",
    "Qwen/Qwen3-Next-80B-A3B-Instruct",
    "Qwen/Qwen3-Next-80B-A3B-Thinking",
    "Qwen/Qwen3-30B-A3B",
    "Qwen/Qwen3-32B",
    "Qwen/Qwen3-14B",

    // === Qwen2.5 系列 ===
    "Qwen/Qwen2.5-72B-Instruct",
    "Qwen/Qwen2.5-72B-Instruct-128K",
    "Qwen/Qwen2.5-32B-Instruct",
    "Qwen/Qwen2.5-14B-Instruct",
    "Qwen/Qwen2.5-Coder-32B-Instruct",
    "Qwen/Qwen2.5-VL-72B-Instruct",
    "Qwen/Qwen2.5-VL-32B-Instruct",
    "Pro/Qwen/Qwen2.5-VL-7B-Instruct",
    "Qwen/QwQ-32B",
    "Qwen/QVQ-72B-Preview",
    "Tongyi-Zhiwen/QwenLong-L1-32B",

    // === 其他厂商 ===
    "stepfun-ai/step3",
    "ByteDance-Seed/Seed-OSS-36B-Instruct",
    "inclusionAI/Ring-flash-2.0",
    "inclusionAI/Ling-flash-2.0",
    "inclusionAI/Ling-mini-2.0",
    "baidu/ERNIE-4.5-300B-A47B",
    "tencent/Hunyuan-A13B-Instruct",
    "ascend-tribe/pangu-pro-moe",
    "Kwaipilot/KAT-Dev",
  ];

  return modelIds.map(buildModelDefinition);
}

/**
 * Response shape from SiliconFlow /models endpoint.
 * Returns OpenAI-compatible format.
 */
interface SiliconFlowModelsResponse {
  data: Array<{
    id: string;
    object: "model";
    created?: number;
    owned_by?: string;
  }>;
}

/**
 * Fetch models from the SiliconFlow API.
 * Uses caching with 1-hour TTL.
 *
 * @param apiKey - SiliconFlow API key for authentication
 * @returns Array of model definitions, or static fallback on failure
 */
export async function fetchSiliconFlowModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  // Return cached models if still valid
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${SILICONFLOW_API_BASE_URL}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as SiliconFlowModelsResponse;

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from /models endpoint");
    }

    const models = data.data.map((model) => buildModelDefinition(model.id));

    cachedModels = models;
    cacheTimestamp = now;

    return models;
  } catch (error) {
    console.warn(`[siliconflow] Failed to fetch models, using static fallback: ${String(error)}`);
    return getSiliconFlowStaticFallbackModels();
  }
}

/**
 * Clear the model cache (useful for testing or forcing refresh).
 */
export function clearSiliconFlowModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}

/**
 * Build the SiliconFlow provider configuration.
 */
export function buildSiliconFlowProvider(apiKey?: string): {
  baseUrl: string;
  api: ModelApi;
  apiKey?: string;
  models: ModelDefinitionConfig[];
} {
  return {
    baseUrl: SILICONFLOW_API_BASE_URL,
    api: "openai-completions",
    ...(apiKey ? { apiKey } : {}),
    models: getSiliconFlowStaticFallbackModels(),
  };
}
