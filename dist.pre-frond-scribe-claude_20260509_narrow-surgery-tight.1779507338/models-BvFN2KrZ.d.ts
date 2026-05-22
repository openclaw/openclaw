import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/deepseek/models.d.ts
declare const DEEPSEEK_BASE_URL: string;
declare const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[];
declare function buildDeepSeekModelDefinition(model: (typeof DEEPSEEK_MODEL_CATALOG)[number]): ModelDefinitionConfig;
declare function isDeepSeekV4ModelId(modelId: string): boolean;
declare function isDeepSeekV4ModelRef(model: {
  provider?: string;
  id?: unknown;
}): boolean;
//#endregion
export { isDeepSeekV4ModelRef as a, isDeepSeekV4ModelId as i, DEEPSEEK_MODEL_CATALOG as n, buildDeepSeekModelDefinition as r, DEEPSEEK_BASE_URL as t };