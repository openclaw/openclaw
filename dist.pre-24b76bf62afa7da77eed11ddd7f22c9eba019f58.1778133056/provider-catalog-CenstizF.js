//#region extensions/kimi-coding/provider-catalog.ts
const KIMI_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_USER_AGENT = "claude-code/0.1.0";
const KIMI_DEFAULT_MODEL_ID = "kimi-code";
const KIMI_LEGACY_MODEL_ID = "k2p5";
const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262144;
const KIMI_CODING_DEFAULT_MAX_TOKENS = 32768;
const KIMI_CODING_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildKimiCodingProvider() {
	return {
		baseUrl: KIMI_BASE_URL,
		api: "anthropic-messages",
		headers: { "User-Agent": KIMI_CODING_USER_AGENT },
		models: [{
			id: KIMI_DEFAULT_MODEL_ID,
			name: "Kimi Code",
			reasoning: true,
			input: ["text", "image"],
			cost: KIMI_CODING_DEFAULT_COST,
			contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
			maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS
		}, {
			id: KIMI_LEGACY_MODEL_ID,
			name: "Kimi Code (legacy model id)",
			reasoning: true,
			input: ["text", "image"],
			cost: KIMI_CODING_DEFAULT_COST,
			contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
			maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS
		}]
	};
}
const KIMI_CODING_BASE_URL = KIMI_BASE_URL;
const KIMI_CODING_DEFAULT_MODEL_ID = KIMI_DEFAULT_MODEL_ID;
//#endregion
export { KIMI_CODING_DEFAULT_MODEL_ID as n, buildKimiCodingProvider as r, KIMI_CODING_BASE_URL as t };
