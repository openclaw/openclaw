import { n as GPT5_FRIENDLY_PROMPT_OVERLAY, o as resolveGpt5PromptOverlayMode, r as isGpt5ModelId, s as resolveGpt5SystemPromptContribution, t as GPT5_BEHAVIOR_CONTRACT } from "./gpt5-prompt-overlay-CBZZ5p1_.js";
import "./provider-model-shared-wmBDALmq.js";
//#region extensions/openai/prompt-overlay.ts
const OPENAI_PROVIDER_IDS = new Set(["openai", "openai-codex"]);
const OPENAI_FRIENDLY_PROMPT_OVERLAY = GPT5_FRIENDLY_PROMPT_OVERLAY;
const OPENAI_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;
function resolveOpenAIPromptOverlayMode(pluginConfig) {
	return resolveGpt5PromptOverlayMode(void 0, pluginConfig);
}
function shouldApplyOpenAIPromptOverlay(params) {
	return OPENAI_PROVIDER_IDS.has(params.modelProviderId ?? "") && isGpt5ModelId(params.modelId);
}
function resolveOpenAISystemPromptContribution(params) {
	return resolveGpt5SystemPromptContribution({
		config: params.config,
		legacyPluginConfig: params.mode === void 0 ? params.legacyPluginConfig : { personality: params.mode },
		modelId: params.modelId,
		enabled: shouldApplyOpenAIPromptOverlay({
			modelProviderId: params.modelProviderId,
			modelId: params.modelId
		})
	});
}
//#endregion
export { shouldApplyOpenAIPromptOverlay as a, resolveOpenAISystemPromptContribution as i, OPENAI_GPT5_BEHAVIOR_CONTRACT as n, resolveOpenAIPromptOverlayMode as r, OPENAI_FRIENDLY_PROMPT_OVERLAY as t };
