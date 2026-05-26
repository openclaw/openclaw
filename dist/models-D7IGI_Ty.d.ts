import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/arcee/models.d.ts
declare const ARCEE_BASE_URL = "https://api.arcee.ai/api/v1";
declare const ARCEE_MODEL_CATALOG: ModelDefinitionConfig[];
declare function buildArceeModelDefinition(model: (typeof ARCEE_MODEL_CATALOG)[number]): ModelDefinitionConfig;
//#endregion
export { ARCEE_MODEL_CATALOG as n, buildArceeModelDefinition as r, ARCEE_BASE_URL as t };