import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/kilocode/provider-models.d.ts
declare const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
declare const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
declare const KILOCODE_DEFAULT_MODEL_REF = "kilocode/kilo/auto";
declare const KILOCODE_DEFAULT_MODEL_NAME = "Kilo Auto";
type KilocodeModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};
declare const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[];
declare const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1000000;
declare const KILOCODE_DEFAULT_MAX_TOKENS = 128000;
declare const KILOCODE_DEFAULT_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const KILOCODE_MODELS_URL = "https://api.kilo.ai/api/gateway/models";
declare function discoverKilocodeModels(): Promise<ModelDefinitionConfig[]>;
declare function buildKilocodeModelDefinition(): ModelDefinitionConfig;
//#endregion
export { KILOCODE_DEFAULT_MODEL_ID as a, KILOCODE_MODELS_URL as c, discoverKilocodeModels as d, KILOCODE_DEFAULT_MAX_TOKENS as i, KILOCODE_MODEL_CATALOG as l, KILOCODE_DEFAULT_CONTEXT_WINDOW as n, KILOCODE_DEFAULT_MODEL_NAME as o, KILOCODE_DEFAULT_COST as r, KILOCODE_DEFAULT_MODEL_REF as s, KILOCODE_BASE_URL as t, buildKilocodeModelDefinition as u };