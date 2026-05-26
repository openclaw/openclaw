import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/zai/model-definitions.d.ts
declare const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
declare const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
declare const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
declare const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
declare const ZAI_DEFAULT_MODEL_ID = "glm-5.1";
declare const ZAI_DEFAULT_MODEL_REF = "zai/glm-5.1";
declare const ZAI_DEFAULT_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tieredPricing?: Array<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    range: [number, number] | [number];
  }>;
};
declare function resolveZaiBaseUrl(endpoint?: string): string;
declare function buildZaiCatalogModels(): ModelDefinitionConfig[];
declare function buildZaiModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ModelDefinitionConfig["input"];
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig;
//#endregion
export { ZAI_DEFAULT_MODEL_ID as a, buildZaiCatalogModels as c, ZAI_DEFAULT_COST as i, buildZaiModelDefinition as l, ZAI_CODING_CN_BASE_URL as n, ZAI_DEFAULT_MODEL_REF as o, ZAI_CODING_GLOBAL_BASE_URL as r, ZAI_GLOBAL_BASE_URL as s, ZAI_CN_BASE_URL as t, resolveZaiBaseUrl as u };