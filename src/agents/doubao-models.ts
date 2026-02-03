import type { ModelDefinitionConfig } from "../config/types.js";

export const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DOUBAO_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
export const DOUBAO_DEFAULT_MODEL_ID = "doubao-seed-1-8-251228";
export const DOUBAO_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export const DOUBAO_DEFAULT_MODEL_REF = `volcengine/${DOUBAO_DEFAULT_MODEL_ID}`;

// Volcano Engine Doubao pricing (approximate, adjust based on actual pricing)
export const DOUBAO_DEFAULT_COST = {
  input: 0.0001, // ¥0.0001 per 1K tokens
  output: 0.0002, // ¥0.0002 per 1K tokens
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Complete catalog of Volcano Engine models.
 *
 * Volcano Engine provides access to models
 * through the API. Authentication requires a Volcano Engine API Key.
 */
export const DOUBAO_MODEL_CATALOG = [
  {
    id: "doubao-seed-code-preview-251028",
    name: "doubao-seed-code-preview-251028",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "doubao-seed-1-8-251228",
    name: "Doubao Seed 1.8",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "kimi-k2-5-260127",
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "glm-4-7-251222",
    name: "GLM 4.7",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 4096,
  },
  {
    id: "deepseek-v3-2-251201",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 4096,
  },
] as const;

export type DoubaoCatalogEntry = (typeof DOUBAO_MODEL_CATALOG)[number];
export type DoubaoCodingCatalogEntry = (typeof DOUBAO_CODING_MODEL_CATALOG)[number];

export function buildDoubaoModelDefinition(
  entry: DoubaoCatalogEntry | DoubaoCodingCatalogEntry,
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: DOUBAO_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

export const DOUBAO_CODING_MODEL_CATALOG = [
  {
    id: "ark-code-latest",
    name: "Ark Coding Plan",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "doubao-seed-code",
    name: "Doubao Seed Code",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "glm-4.7",
    name: "GLM 4.7 Coding",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 200000,
    maxTokens: 4096,
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5 Coding",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "doubao-seed-code-preview-251028",
    name: "Doubao Seed Code Preview",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 4096,
  },
] as const;
