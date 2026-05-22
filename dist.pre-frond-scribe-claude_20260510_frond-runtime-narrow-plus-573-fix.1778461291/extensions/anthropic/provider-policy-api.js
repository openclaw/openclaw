import { u as resolveClaudeThinkingProfile } from "../../provider-model-shared-BJrHvRZi.js";
import { n as normalizeAnthropicProviderConfigForProvider, t as applyAnthropicConfigDefaults } from "../../config-defaults-DcFLIqIt.js";
//#region extensions/anthropic/provider-policy-api.ts
function normalizeConfig(params) {
	return normalizeAnthropicProviderConfigForProvider(params);
}
function applyConfigDefaults(params) {
	return applyAnthropicConfigDefaults(params);
}
function resolveThinkingProfile(params) {
	switch (params.provider.trim().toLowerCase()) {
		case "anthropic":
		case "claude-cli": return resolveClaudeThinkingProfile(params.modelId);
		default: return null;
	}
}
//#endregion
export { applyConfigDefaults, normalizeConfig, resolveThinkingProfile };
