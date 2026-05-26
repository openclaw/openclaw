import { a as isGpt5ModelId, c as resolveGpt5PromptOverlayMode, i as GPT5_HEARTBEAT_PROMPT_OVERLAY, l as resolveGpt5SystemPromptContribution, n as GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY, t as GPT5_BEHAVIOR_CONTRACT } from "./gpt5-prompt-overlay-ijXG4a4G.js";
import "./provider-model-shared-DtsPmvDx.js";
//#region extensions/openai/prompt-overlay.ts
const OPENAI_PROVIDER_IDS = new Set(["openai", "openai-codex"]);
const OPENAI_FRIENDLY_PROMPT_OVERLAY = GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY;
const OPENAI_HEARTBEAT_PROMPT_OVERLAY = GPT5_HEARTBEAT_PROMPT_OVERLAY;
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
		trigger: params.trigger,
		enabled: shouldApplyOpenAIPromptOverlay({
			modelProviderId: params.modelProviderId,
			modelId: params.modelId
		})
	});
}
//#endregion
export { resolveOpenAISystemPromptContribution as a, resolveOpenAIPromptOverlayMode as i, OPENAI_GPT5_BEHAVIOR_CONTRACT as n, shouldApplyOpenAIPromptOverlay as o, OPENAI_HEARTBEAT_PROMPT_OVERLAY as r, OPENAI_FRIENDLY_PROMPT_OVERLAY as t };
