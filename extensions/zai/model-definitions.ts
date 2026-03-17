import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";

export const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
export const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZAI_DEFAULT_MODEL_ID = "glm-5";
export const ZAI_DEFAULT_MODEL_REF = `zai/${ZAI_DEFAULT_MODEL_ID}`;

export const ZAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const ZAI_MODEL_CATALOG = {
  "glm-5": { name: "GLM-5", reasoning: true },
  "glm-5-turbo": { name: "GLM-5 Turbo", reasoning: true },
  "glm-4.7": { name: "GLM-4.7", reasoning: true },
  "glm-4.7-flash": { name: "GLM-4.7 Flash", reasoning: true },
  "glm-4.7-flashx": { name: "GLM-4.7 FlashX", reasoning: true },
} as const;

type ZaiCatalogId = keyof typeof ZAI_MODEL_CATALOG;

export function resolveZaiBaseUrl(endpoint?: string): string {
  switch (endpoint) {
    case "coding-cn":
      return ZAI_CODING_CN_BASE_URL;
    case "global":
      return ZAI_GLOBAL_BASE_URL;
    case "cn":
      return ZAI_CN_BASE_URL;
    case "coding-global":
      return ZAI_CODING_GLOBAL_BASE_URL;
    default:
      return ZAI_GLOBAL_BASE_URL;
  }
}

export function buildZaiModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = ZAI_MODEL_CATALOG[params.id as ZaiCatalogId];
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? `GLM ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? true,
    input: ["text"],
    cost: params.cost ?? ZAI_DEFAULT_COST,
    contextWindow: params.contextWindow ?? 204800,
    maxTokens: params.maxTokens ?? 131072,
  };
}
