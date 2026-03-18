//#region src/providers/kilocode-shared.ts
const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
/**
* Static fallback catalog — used by the sync setup path and as a
* fallback when dynamic model discovery from the gateway API fails.
* The full model list is fetched dynamically by {@link discoverKilocodeModels}
* in `src/agents/kilocode-models.ts`.
*/
const KILOCODE_MODEL_CATALOG = [{
	id: KILOCODE_DEFAULT_MODEL_ID,
	name: "Kilo Auto",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1e6,
	maxTokens: 128e3
}];
const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1e6;
const KILOCODE_DEFAULT_MAX_TOKENS = 128e3;
const KILOCODE_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
//#endregion
export { KILOCODE_DEFAULT_MODEL_REF as a, KILOCODE_DEFAULT_MAX_TOKENS as i, KILOCODE_DEFAULT_CONTEXT_WINDOW as n, KILOCODE_MODEL_CATALOG as o, KILOCODE_DEFAULT_COST as r, KILOCODE_BASE_URL as t };
