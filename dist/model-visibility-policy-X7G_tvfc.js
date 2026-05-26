import { r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { u as resolveAgentModelFallbacksOverride } from "./agent-scope-CtLXGcWm.js";
import { a as createModelVisibilityPolicyWithFallbacks } from "./model-selection-shared-ClxdEp4X.js";
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
		}),
		manifestPlugins: params.manifestPlugins
	});
}
//#endregion
export { createModelVisibilityPolicy as t };
