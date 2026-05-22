import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/mistral/model-definitions.d.ts
declare const MISTRAL_BASE_URL: string;
declare const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";
declare const MISTRAL_DEFAULT_CONTEXT_WINDOW: number;
declare const MISTRAL_DEFAULT_MAX_TOKENS: number;
declare const MISTRAL_DEFAULT_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} | {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare function buildMistralModelDefinition(): ModelDefinitionConfig;
declare function buildMistralCatalogModels(): ModelDefinitionConfig[];
//#endregion
export { MISTRAL_DEFAULT_MODEL_ID as a, MISTRAL_DEFAULT_MAX_TOKENS as i, MISTRAL_DEFAULT_CONTEXT_WINDOW as n, buildMistralCatalogModels as o, MISTRAL_DEFAULT_COST as r, buildMistralModelDefinition as s, MISTRAL_BASE_URL as t };