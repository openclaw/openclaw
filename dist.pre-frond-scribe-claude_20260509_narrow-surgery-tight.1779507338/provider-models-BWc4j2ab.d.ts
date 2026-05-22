import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/deepinfra/provider-models.d.ts
declare const DEEPINFRA_BASE_URL: string;
declare const DEEPINFRA_MODELS_URL: string;
declare const DEEPINFRA_DEFAULT_MODEL_ID = "deepseek-ai/DeepSeek-V3.2";
declare const DEEPINFRA_DEFAULT_MODEL_REF = "deepinfra/deepseek-ai/DeepSeek-V3.2";
declare const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[];
declare function resetDeepInfraModelCacheForTest(): void;
declare function buildDeepInfraModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig;
declare function discoverDeepInfraModels(): Promise<ModelDefinitionConfig[]>;
//#endregion
export { DEEPINFRA_MODEL_CATALOG as a, resetDeepInfraModelCacheForTest as c, DEEPINFRA_MODELS_URL as i, DEEPINFRA_DEFAULT_MODEL_ID as n, buildDeepInfraModelDefinition as o, DEEPINFRA_DEFAULT_MODEL_REF as r, discoverDeepInfraModels as s, DEEPINFRA_BASE_URL as t };