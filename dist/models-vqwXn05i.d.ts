import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/together/models.d.ts
declare const TOGETHER_BASE_URL: string;
declare const TOGETHER_MODEL_CATALOG: ModelDefinitionConfig[];
declare function buildTogetherModelDefinition(model: (typeof TOGETHER_MODEL_CATALOG)[number]): ModelDefinitionConfig;
//#endregion
export { TOGETHER_MODEL_CATALOG as n, buildTogetherModelDefinition as r, TOGETHER_BASE_URL as t };