/**
 * Redpill AI GPU TEE Model Catalog
 *
 * Redpill AI provides access to AI models running in GPU-based Trusted Execution Environments (TEEs).
 * These models run inside secure hardware enclaves with cryptographic attestation, ensuring:
 * - Memory encryption and isolation
 * - Tamper-proof execution
 * - Verifiable computation
 * - Privacy-preserving inference
 *
 * Supported TEE providers:
 * - Phala Network (10 models)
 * - Tinfoil (4 models)
 * - Chutes (2 models)
 * - Near-AI (3 models)
 *
 * This catalog serves as the source of truth for available GPU TEE models.
 */

import type { ModelDefinitionConfig } from "../config/types.js";

/**
 * Redpill AI API base URL
 */
export const REDPILL_BASE_URL = "https://api.redpill.ai/v1";

/**
 * Default model for Redpill AI provider
 */
export const REDPILL_DEFAULT_MODEL = "deepseek/deepseek-v3.2";

/**
 * Default model reference (human-readable)
 */
export const REDPILL_DEFAULT_MODEL_REF = `redpill/${REDPILL_DEFAULT_MODEL}`;

/**
 * Cache for model list fetched from API
 */
let cachedModels: ModelDefinitionConfig[] | null = null;

/**
 * Timestamp of last cache update
 */
let cacheTimestamp: number | null = null;

/**
 * Cache TTL: 1 hour
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * GPU TEE model catalog entry
 *
 * maxTokens is omitted — computed as 80% of contextWindow.
 * Cost is per 1M tokens (USD).
 */
export interface RedpillCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  cost: { input: number; output: number };
}

/**
 * Static catalog of verified GPU TEE models
 *
 * Sources:
 * - Phala Network: 10 models
 * - Tinfoil: 4 models
 * - Chutes: 2 models
 * - Near-AI: 3 models
 */
export const REDPILL_GPU_TEE_CATALOG: RedpillCatalogEntry[] = [
  // Phala Network (10 models)
  {
    id: "z-ai/glm-4.7-flash",
    name: "GLM 4.7 Flash (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 203_000,
    cost: { input: 0.1, output: 0.43 },
  },
  {
    id: "qwen/qwen3-embedding-8b",
    name: "Qwen3 Embedding 8B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 33_000,
    cost: { input: 0.01, output: 0 },
  },
  {
    id: "phala/uncensored-24b",
    name: "Uncensored 24B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 33_000,
    cost: { input: 0.2, output: 0.9 },
  },
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek v3.2 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 164_000,
    cost: { input: 0.27, output: 0.4 },
  },
  {
    id: "qwen/qwen3-vl-30b-a3b-instruct",
    name: "Qwen3 VL 30B (GPU TEE)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    cost: { input: 0.2, output: 0.7 },
  },
  {
    id: "sentence-transformers/all-minilm-l6-v2",
    name: "All-MiniLM-L6-v2 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 512,
    cost: { input: 0.005, output: 0 },
  },
  {
    id: "qwen/qwen-2.5-7b-instruct",
    name: "Qwen 2.5 7B Instruct (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 33_000,
    cost: { input: 0.04, output: 0.1 },
  },
  {
    id: "google/gemma-3-27b-it",
    name: "Gemma 3 27B IT (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 54_000,
    cost: { input: 0.11, output: 0.4 },
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_000,
    cost: { input: 0.1, output: 0.49 },
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT OSS 20B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_000,
    cost: { input: 0.04, output: 0.15 },
  },

  // Tinfoil (4 models)
  {
    id: "moonshotai/kimi-k2-thinking",
    name: "Kimi K2 Thinking (GPU TEE)",
    reasoning: true,
    input: ["text"],
    contextWindow: 262_000,
    cost: { input: 2.0, output: 2.0 },
  },
  {
    id: "deepseek/deepseek-r1-0528",
    name: "DeepSeek R1 (GPU TEE)",
    reasoning: true,
    input: ["text"],
    contextWindow: 164_000,
    cost: { input: 2.0, output: 2.0 },
  },
  {
    id: "qwen/qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480B (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 262_000,
    cost: { input: 2.0, output: 2.0 },
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B Instruct (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_000,
    cost: { input: 2.0, output: 2.0 },
  },

  // Chutes (2 models)
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5 (GPU TEE)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262_000,
    cost: { input: 0.6, output: 3.0 },
  },
  {
    id: "minimax/minimax-m2.1",
    name: "MiniMax M2.1 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 197_000,
    cost: { input: 0.3, output: 1.2 },
  },

  // Near-AI (3 models)
  {
    id: "deepseek/deepseek-chat-v3.1",
    name: "DeepSeek Chat v3.1 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 164_000,
    cost: { input: 1.0, output: 2.5 },
  },
  {
    id: "qwen/qwen3-30b-a3b-instruct-2507",
    name: "Qwen3 30B Instruct (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 262_000,
    cost: { input: 0.15, output: 0.45 },
  },
  {
    id: "z-ai/glm-4.7",
    name: "GLM 4.7 (GPU TEE)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_000,
    cost: { input: 0.85, output: 3.3 },
  },
];

/**
 * Convert catalog entry to model definition
 */
function catalogEntryToModelDefinition(entry: RedpillCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxTokens: Math.floor(entry.contextWindow * 0.8),
    cost: {
      input: entry.cost.input,
      output: entry.cost.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
    input: entry.input,
    reasoning: entry.reasoning,
  };
}

/**
 * Discover cached model list or convert from catalog
 */
export function discoverRedpillModels(): ModelDefinitionConfig[] {
  const now = Date.now();

  // Return cached models if still valid
  if (cachedModels && cacheTimestamp && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  // Convert catalog to model definitions
  const models = REDPILL_GPU_TEE_CATALOG.map(catalogEntryToModelDefinition);

  // Update cache
  cachedModels = models;
  cacheTimestamp = now;

  return models;
}

/**
 * Reset cache (useful for testing)
 */
export function resetRedpillModelCache(): void {
  cachedModels = null;
  cacheTimestamp = null;
}
