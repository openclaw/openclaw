import type { ModelDefinitionConfig } from "../config/types.js";
import {
  buildVolcModelDefinition,
  VOLC_MODEL_GLM_4_7,
  VOLC_MODEL_KIMI_K2_5,
  VOLC_SHARED_CODING_MODEL_CATALOG,
} from "./volc-models.shared.js";

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
  VOLC_MODEL_KIMI_K2_5,
  VOLC_MODEL_GLM_4_7,
] as const;

export type BytePlusCatalogEntry = (typeof BYTEPLUS_MODEL_CATALOG)[number];
export type BytePlusCodingCatalogEntry = (typeof BYTEPLUS_CODING_MODEL_CATALOG)[number];

export function buildBytePlusModelDefinition(
  entry: BytePlusCatalogEntry | BytePlusCodingCatalogEntry,
): ModelDefinitionConfig {
  return buildVolcModelDefinition(entry, BYTEPLUS_DEFAULT_COST);
}

export const BYTEPLUS_CODING_MODEL_CATALOG = VOLC_SHARED_CODING_MODEL_CATALOG;
