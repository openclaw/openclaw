import { d as createDefaultModelPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
//#region extensions/litellm/onboard.ts
const LITELLM_BASE_URL = "http://localhost:4000";
const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
const LITELLM_DEFAULT_MODEL_REF = `litellm/${LITELLM_DEFAULT_MODEL_ID}`;
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128e3;
const LITELLM_DEFAULT_MAX_TOKENS = 8192;
const LITELLM_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildLitellmModelDefinition() {
	return {
		id: LITELLM_DEFAULT_MODEL_ID,
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: LITELLM_DEFAULT_COST,
		contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
		maxTokens: LITELLM_DEFAULT_MAX_TOKENS
	};
}
const litellmPresetAppliers = createDefaultModelPresetAppliers({
	primaryModelRef: LITELLM_DEFAULT_MODEL_REF,
	resolveParams: (cfg) => {
		const existingProvider = cfg.models?.providers?.litellm;
		return {
			providerId: "litellm",
			api: "openai-completions",
			baseUrl: (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "") || "http://localhost:4000",
			defaultModel: buildLitellmModelDefinition(),
			defaultModelId: LITELLM_DEFAULT_MODEL_ID,
			aliases: [{
				modelRef: LITELLM_DEFAULT_MODEL_REF,
				alias: "LiteLLM"
			}]
		};
	}
});
function applyLitellmProviderConfig(cfg) {
	return litellmPresetAppliers.applyProviderConfig(cfg);
}
function applyLitellmConfig(cfg) {
	return litellmPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyLitellmProviderConfig as a, applyLitellmConfig as i, LITELLM_DEFAULT_MODEL_ID as n, buildLitellmModelDefinition as o, LITELLM_DEFAULT_MODEL_REF as r, LITELLM_BASE_URL as t };
