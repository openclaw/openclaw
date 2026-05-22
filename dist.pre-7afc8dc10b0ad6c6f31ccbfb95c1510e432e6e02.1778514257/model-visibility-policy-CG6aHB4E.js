import { r as resolveAgentModelFallbackValues } from "./model-input-WCN93Is3.js";
import { s as resolveAgentModelFallbacksOverride } from "./agent-scope-BnhYEQue.js";
import { a as createModelVisibilityPolicyWithFallbacks } from "./model-selection-shared-DEFYGBdW.js";
//#region src/agents/model-visibility-policy.ts
function resolveAllowedFallbacks(params) {
	if (params.agentId) {
		const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
		if (override !== void 0) return override;
	}
	return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}
function createModelVisibilityPolicy(params) {
	return createModelVisibilityPolicyWithFallbacks({
		cfg: params.cfg,
		catalog: params.catalog,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		fallbackModels: resolveAllowedFallbacks({
			cfg: params.cfg,
			agentId: params.agentId
		})
	});
}
//#endregion
export { createModelVisibilityPolicy as t };
