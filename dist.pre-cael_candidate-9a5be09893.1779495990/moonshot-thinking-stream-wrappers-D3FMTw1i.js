import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
//#region src/agents/pi-embedded-runner/stream-payload-utils.ts
function streamWithPayloadPatch(underlying, model, context, options, patchPayload) {
	const originalOnPayload = options?.onPayload;
	return underlying(model, context, {
		...options,
		onPayload: (payload) => {
			if (payload && typeof payload === "object") patchPayload(payload);
			return originalOnPayload?.(payload, model);
		}
	});
}
//#endregion
//#region src/agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.ts
const MOONSHOT_THINKING_KEEP_MODEL_ID = "kimi-k2.6";
const piAiRuntimeLoader = createLazyImportLoader(() => import("@earendil-works/pi-ai"));
async function loadDefaultStreamFn() {
	return (await piAiRuntimeLoader.load()).streamSimple;
}
function normalizeMoonshotThinkingType(value) {
	if (typeof value === "boolean") return value ? "enabled" : "disabled";
	if (typeof value === "string") {
		const normalized = normalizeOptionalLowercaseString(value);
		if (!normalized) return;
		if ([
			"enabled",
			"enable",
			"on",
			"true"
		].includes(normalized)) return "enabled";
		if ([
			"disabled",
			"disable",
			"off",
			"false"
		].includes(normalized)) return "disabled";
		return;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) return normalizeMoonshotThinkingType(value.type);
}
function normalizeMoonshotThinkingKeep(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const keepValue = value.keep;
	if (typeof keepValue !== "string") return;
	return normalizeOptionalLowercaseString(keepValue) === "all" ? "all" : void 0;
}
function isMoonshotToolChoiceCompatible(toolChoice) {
	if (toolChoice == null || toolChoice === "auto" || toolChoice === "none") return true;
	if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
		const typeValue = toolChoice.type;
		return typeValue === "auto" || typeValue === "none";
	}
	return false;
}
function isPinnedToolChoice(toolChoice) {
	if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return false;
	const typeValue = toolChoice.type;
	return typeValue === "tool" || typeValue === "function";
}
/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
function resolveMoonshotThinkingType(params) {
	const configured = normalizeMoonshotThinkingType(params.configuredThinking);
	if (configured) return configured;
	if (!params.thinkingLevel) return;
	return params.thinkingLevel === "off" ? "disabled" : "enabled";
}
/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
function resolveMoonshotThinkingKeep(params) {
	return normalizeMoonshotThinkingKeep(params.configuredThinking);
}
/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
function createMoonshotThinkingWrapper(baseStreamFn, thinkingType, thinkingKeep) {
	return async (model, context, options) => {
		return streamWithPayloadPatch(baseStreamFn ?? await loadDefaultStreamFn(), model, context, options, (payloadObj) => {
			let effectiveThinkingType = normalizeMoonshotThinkingType(payloadObj.thinking);
			if (thinkingType) {
				payloadObj.thinking = { type: thinkingType };
				effectiveThinkingType = thinkingType;
			}
			if (effectiveThinkingType === "enabled" && !isMoonshotToolChoiceCompatible(payloadObj.tool_choice)) {
				if (payloadObj.tool_choice === "required") payloadObj.tool_choice = "auto";
				else if (isPinnedToolChoice(payloadObj.tool_choice)) {
					payloadObj.thinking = { type: "disabled" };
					effectiveThinkingType = "disabled";
				}
			}
			const isKeepCapableModel = payloadObj.model === MOONSHOT_THINKING_KEEP_MODEL_ID;
			if (payloadObj.thinking && typeof payloadObj.thinking === "object") {
				const thinkingObj = payloadObj.thinking;
				if (isKeepCapableModel && effectiveThinkingType === "enabled" && thinkingKeep === "all") thinkingObj.keep = "all";
				else if ("keep" in thinkingObj) delete thinkingObj.keep;
			}
		});
	};
}
//#endregion
export { streamWithPayloadPatch as i, resolveMoonshotThinkingKeep as n, resolveMoonshotThinkingType as r, createMoonshotThinkingWrapper as t };
