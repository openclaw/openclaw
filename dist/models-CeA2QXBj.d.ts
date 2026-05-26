import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/huggingface/models.d.ts
declare const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
declare const HUGGINGFACE_POLICY_SUFFIXES: readonly ["cheapest", "fastest"];
declare const HUGGINGFACE_DISCOVERY_TIMEOUT_MS = 30000;
declare const HUGGINGFACE_MODEL_CATALOG: ModelDefinitionConfig[];
declare function isHuggingfacePolicyLocked(modelRef: string): boolean;
declare function buildHuggingfaceModelDefinition(model: (typeof HUGGINGFACE_MODEL_CATALOG)[number]): ModelDefinitionConfig;
declare function discoverHuggingfaceModels(apiKey: string, timeoutMs?: number): Promise<ModelDefinitionConfig[]>;
//#endregion
export { buildHuggingfaceModelDefinition as a, HUGGINGFACE_POLICY_SUFFIXES as i, HUGGINGFACE_DISCOVERY_TIMEOUT_MS as n, discoverHuggingfaceModels as o, HUGGINGFACE_MODEL_CATALOG as r, isHuggingfacePolicyLocked as s, HUGGINGFACE_BASE_URL as t };