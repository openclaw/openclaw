import type { ModelDefinitionConfig } from "../config/types.js";

export const BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
export const BYTEPLUS_CODING_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/coding/v3";
export const BYTEPLUS_DEFAULT_MODEL_ID = "seed-1-8-251228";
export const BYTEPLUS_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export const BYTEPLUS_DEFAULT_MODEL_REF = `byteplus/${BYTEPLUS_DEFAULT_MODEL_ID}`;

// BytePlus pricing (approximate, adjust based on actual pricing)
export const BYTEPLUS_DEFAULT_COST = {
  input: 0.0001, // $0.0001 per 1K tokens
  output: 0.0002, // $0.0002 per 1K tokens
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Complete catalog of BytePlus ARK models.
 *
 * BytePlus ARK provides access to various models
 * through the ARK API. Authentication requires a BYTEPLUS_API_KEY.
 */
export const BYTEPLUS_MODEL_CATALOG = [
  {
    id: "seed-1-8-251228",
    name: "Seed 1.8",
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
] as const;

export type BytePlusCatalogEntry = (typeof BYTEPLUS_MODEL_CATALOG)[number];
export type BytePlusCodingCatalogEntry = (typeof BYTEPLUS_CODING_MODEL_CATALOG)[number];

export function buildBytePlusModelDefinition(
  entry: BytePlusCatalogEntry | BytePlusCodingCatalogEntry,
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: BYTEPLUS_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

export const BYTEPLUS_CODING_MODEL_CATALOG = [
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
] as const;
