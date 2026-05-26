import { n as resolveOpenAIThinkingProfile, t as resolveOpenAICodexThinkingProfile } from "../../thinking-policy-CkZmF4BG.js";
//#region extensions/openai/provider-policy-api.ts
function normalizeConfig(params) {
	return params.providerConfig;
}
function resolveThinkingProfile(params) {
	switch (params.provider.trim().toLowerCase()) {
		case "openai": return resolveOpenAIThinkingProfile(params.modelId);
		case "openai-codex": return resolveOpenAICodexThinkingProfile(params.modelId);
		default: return null;
	}
}
//#endregion
export { normalizeConfig, resolveThinkingProfile };
