import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/byteplus/models.d.ts
declare const BYTEPLUS_BASE_URL: string;
declare const BYTEPLUS_CODING_BASE_URL: string;
declare const BYTEPLUS_DEFAULT_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const BYTEPLUS_MODEL_CATALOG: ModelDefinitionConfig[];
declare const BYTEPLUS_CODING_MODEL_CATALOG: ModelDefinitionConfig[];
declare function buildBytePlusModelDefinition(entry: ModelDefinitionConfig): ModelDefinitionConfig;
//#endregion
export { BYTEPLUS_MODEL_CATALOG as a, BYTEPLUS_DEFAULT_COST as i, BYTEPLUS_CODING_BASE_URL as n, buildBytePlusModelDefinition as o, BYTEPLUS_CODING_MODEL_CATALOG as r, BYTEPLUS_BASE_URL as t };