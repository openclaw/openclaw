import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/chutes/models.d.ts
declare const CHUTES_BASE_URL = "https://llm.chutes.ai/v1";
declare const CHUTES_DEFAULT_MODEL_ID = "zai-org/GLM-4.7-TEE";
declare const CHUTES_DEFAULT_MODEL_REF = "chutes/zai-org/GLM-4.7-TEE";
declare const CHUTES_MODEL_CATALOG: ModelDefinitionConfig[];
declare function buildChutesModelDefinition(model: (typeof CHUTES_MODEL_CATALOG)[number]): ModelDefinitionConfig;
declare function clearChutesModelCacheForTests(): void;
declare function discoverChutesModels(accessToken?: string): Promise<ModelDefinitionConfig[]>;
//#endregion
export { buildChutesModelDefinition as a, CHUTES_MODEL_CATALOG as i, CHUTES_DEFAULT_MODEL_ID as n, clearChutesModelCacheForTests as o, CHUTES_DEFAULT_MODEL_REF as r, discoverChutesModels as s, CHUTES_BASE_URL as t };