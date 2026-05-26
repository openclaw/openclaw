import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/cerebras/models.d.ts
declare const CEREBRAS_BASE_URL: string;
declare const CEREBRAS_MODEL_CATALOG: ({
  id: string;
  name: string;
  input: string[];
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
} | {
  id: string;
  name: string;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  reasoning?: undefined;
})[];
declare function buildCerebrasCatalogModels(): ModelDefinitionConfig[];
declare function buildCerebrasModelDefinition(model: (typeof CEREBRAS_MODEL_CATALOG)[number]): ModelDefinitionConfig;
//#endregion
export { buildCerebrasModelDefinition as i, CEREBRAS_MODEL_CATALOG as n, buildCerebrasCatalogModels as r, CEREBRAS_BASE_URL as t };