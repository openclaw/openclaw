import { r as MINIMAX_TEXT_MODEL_CATALOG, t as MINIMAX_DEFAULT_MODEL_ID } from "./provider-models-DHcchnyE.js";
//#region extensions/minimax/model-definitions.ts
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_CN_API_BASE_URL = "https://api.minimaxi.com/anthropic";
const MINIMAX_HOSTED_MODEL_ID = MINIMAX_DEFAULT_MODEL_ID;
const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;
const DEFAULT_MINIMAX_CONTEXT_WINDOW = 204800;
const DEFAULT_MINIMAX_MAX_TOKENS = 131072;
const MINIMAX_API_COST = {
	input: .3,
	output: 1.2,
	cacheRead: .06,
	cacheWrite: .375
};
const MINIMAX_API_HIGHSPEED_COST = {
	input: .6,
	output: 2.4,
	cacheRead: .06,
	cacheWrite: .375
};
const MINIMAX_M25_API_COST = {
	input: .3,
	output: 1.2,
	cacheRead: .03,
	cacheWrite: .375
};
const MINIMAX_M25_API_HIGHSPEED_COST = {
	input: .6,
	output: 2.4,
	cacheRead: .03,
	cacheWrite: .375
};
const MINIMAX_HOSTED_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MINIMAX_LM_STUDIO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function resolveMinimaxApiCost(modelId) {
	if (modelId === "MiniMax-M2.5-highspeed") return MINIMAX_M25_API_HIGHSPEED_COST;
	if (modelId === "MiniMax-M2.5") return MINIMAX_M25_API_COST;
	if (modelId === "MiniMax-M2.7-highspeed") return MINIMAX_API_HIGHSPEED_COST;
	return MINIMAX_API_COST;
}
function buildMinimaxModelDefinition(params) {
	const catalog = MINIMAX_TEXT_MODEL_CATALOG[params.id];
	return {
		id: params.id,
		name: params.name ?? catalog?.name ?? `MiniMax ${params.id}`,
		reasoning: params.reasoning ?? catalog?.reasoning ?? false,
		input: ["text"],
		cost: params.cost,
		contextWindow: params.contextWindow,
		maxTokens: params.maxTokens
	};
}
function buildMinimaxApiModelDefinition(modelId) {
	return buildMinimaxModelDefinition({
		id: modelId,
		cost: resolveMinimaxApiCost(modelId),
		contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MINIMAX_MAX_TOKENS
	});
}
//#endregion
export { MINIMAX_API_COST as a, MINIMAX_HOSTED_COST as c, MINIMAX_LM_STUDIO_COST as d, MINIMAX_M25_API_COST as f, resolveMinimaxApiCost as g, buildMinimaxModelDefinition as h, MINIMAX_API_BASE_URL as i, MINIMAX_HOSTED_MODEL_ID as l, buildMinimaxApiModelDefinition as m, DEFAULT_MINIMAX_CONTEXT_WINDOW as n, MINIMAX_API_HIGHSPEED_COST as o, MINIMAX_M25_API_HIGHSPEED_COST as p, DEFAULT_MINIMAX_MAX_TOKENS as r, MINIMAX_CN_API_BASE_URL as s, DEFAULT_MINIMAX_BASE_URL as t, MINIMAX_HOSTED_MODEL_REF as u };
