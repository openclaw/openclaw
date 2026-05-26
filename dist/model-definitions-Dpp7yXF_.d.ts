import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/minimax/model-definitions.d.ts
declare const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
declare const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
declare const MINIMAX_CN_API_BASE_URL = "https://api.minimaxi.com/anthropic";
declare const MINIMAX_HOSTED_MODEL_ID = "MiniMax-M2.7";
declare const MINIMAX_HOSTED_MODEL_REF = "minimax/MiniMax-M2.7";
declare const DEFAULT_MINIMAX_CONTEXT_WINDOW = 204800;
declare const DEFAULT_MINIMAX_MAX_TOKENS = 131072;
declare const MINIMAX_API_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const MINIMAX_API_HIGHSPEED_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const MINIMAX_M25_API_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const MINIMAX_M25_API_HIGHSPEED_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const MINIMAX_HOSTED_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const MINIMAX_LM_STUDIO_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare function resolveMinimaxApiCost(modelId: string): ModelDefinitionConfig["cost"];
declare function buildMinimaxModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  cost: ModelDefinitionConfig["cost"];
  contextWindow: number;
  maxTokens: number;
}): ModelDefinitionConfig;
declare function buildMinimaxApiModelDefinition(modelId: string): ModelDefinitionConfig;
//#endregion
export { MINIMAX_API_COST as a, MINIMAX_HOSTED_COST as c, MINIMAX_LM_STUDIO_COST as d, MINIMAX_M25_API_COST as f, resolveMinimaxApiCost as g, buildMinimaxModelDefinition as h, MINIMAX_API_BASE_URL as i, MINIMAX_HOSTED_MODEL_ID as l, buildMinimaxApiModelDefinition as m, DEFAULT_MINIMAX_CONTEXT_WINDOW as n, MINIMAX_API_HIGHSPEED_COST as o, MINIMAX_M25_API_HIGHSPEED_COST as p, DEFAULT_MINIMAX_MAX_TOKENS as r, MINIMAX_CN_API_BASE_URL as s, DEFAULT_MINIMAX_BASE_URL as t, MINIMAX_HOSTED_MODEL_REF as u };