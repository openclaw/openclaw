import { u as matchesExactOrPrefix } from "./provider-model-shared-DtsPmvDx.js";
//#region extensions/minimax/provider-models.ts
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.7";
const MINIMAX_DEFAULT_MODEL_REF = `minimax/${MINIMAX_DEFAULT_MODEL_ID}`;
const MINIMAX_TEXT_MODEL_ORDER = ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"];
const MINIMAX_TEXT_MODEL_CATALOG = {
	"MiniMax-M2.7": {
		name: "MiniMax M2.7",
		reasoning: true
	},
	"MiniMax-M2.7-highspeed": {
		name: "MiniMax M2.7 Highspeed",
		reasoning: true
	}
};
const MINIMAX_TEXT_MODEL_REFS = MINIMAX_TEXT_MODEL_ORDER.map((modelId) => `minimax/${modelId}`);
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"];
function isMiniMaxModernModelId(modelId) {
	return matchesExactOrPrefix(modelId, MINIMAX_MODERN_MODEL_MATCHERS);
}
//#endregion
export { MINIMAX_TEXT_MODEL_REFS as a, MINIMAX_TEXT_MODEL_ORDER as i, MINIMAX_DEFAULT_MODEL_REF as n, isMiniMaxModernModelId as o, MINIMAX_TEXT_MODEL_CATALOG as r, MINIMAX_DEFAULT_MODEL_ID as t };
