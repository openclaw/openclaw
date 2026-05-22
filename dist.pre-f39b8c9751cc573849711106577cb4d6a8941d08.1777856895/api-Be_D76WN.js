import "./provider-catalog-DzKMOSpA.js";
import "./model-definitions-DfRewOMe.js";
import "./onboard-CgzT_q7G.js";
const MISTRAL_MODEL_TRANSPORT_PATCH = {
	supportsStore: false,
	maxTokensField: "max_tokens"
};
const MISTRAL_SMALL_LATEST_REASONING_EFFORT_MAP = {
	off: "none",
	minimal: "none",
	low: "high",
	medium: "high",
	high: "high",
	xhigh: "high",
	adaptive: "high",
	max: "high"
};
const MISTRAL_SMALL_LATEST_ID = "mistral-small-latest";
function resolveMistralCompatPatch(model) {
	const reasoningEnabled = model.id === MISTRAL_SMALL_LATEST_ID;
	return {
		...MISTRAL_MODEL_TRANSPORT_PATCH,
		supportsReasoningEffort: reasoningEnabled,
		reasoningEffortMap: reasoningEnabled ? MISTRAL_SMALL_LATEST_REASONING_EFFORT_MAP : void 0
	};
}
function compatMatchesResolved(compat, modelId) {
	const expected = resolveMistralCompatPatch({ id: modelId });
	return compat?.supportsStore === expected.supportsStore && compat?.supportsReasoningEffort === expected.supportsReasoningEffort && compat?.maxTokensField === expected.maxTokensField && compat?.reasoningEffortMap === expected.reasoningEffortMap;
}
function applyMistralModelCompat(model) {
	const compat = model.compat && typeof model.compat === "object" ? model.compat : void 0;
	if (compatMatchesResolved(compat, model.id)) return model;
	const patch = resolveMistralCompatPatch(model);
	return {
		...model,
		compat: {
			...compat,
			...patch
		}
	};
}
//#endregion
export { resolveMistralCompatPatch as i, MISTRAL_SMALL_LATEST_ID as n, applyMistralModelCompat as r, MISTRAL_MODEL_TRANSPORT_PATCH as t };
