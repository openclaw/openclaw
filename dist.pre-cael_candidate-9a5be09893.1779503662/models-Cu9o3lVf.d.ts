import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/volcengine/models.d.ts
declare const DOUBAO_BASE_URL: string;
declare const DOUBAO_CODING_BASE_URL: string;
declare const DOUBAO_MODEL_CATALOG: ModelDefinitionConfig[];
declare const DOUBAO_CODING_MODEL_CATALOG: ModelDefinitionConfig[];
declare function buildDoubaoModelDefinition(entry: ModelDefinitionConfig): ModelDefinitionConfig;
//#endregion
export { buildDoubaoModelDefinition as a, DOUBAO_MODEL_CATALOG as i, DOUBAO_CODING_BASE_URL as n, DOUBAO_CODING_MODEL_CATALOG as r, DOUBAO_BASE_URL as t };