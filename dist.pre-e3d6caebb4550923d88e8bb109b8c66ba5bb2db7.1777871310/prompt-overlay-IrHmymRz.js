import { a as renderGpt5PromptOverlay, s as resolveGpt5SystemPromptContribution, t as GPT5_BEHAVIOR_CONTRACT } from "./gpt5-prompt-overlay-CBZZ5p1_.js";
import "./provider-model-shared-wmBDALmq.js";
//#region extensions/codex/prompt-overlay.ts
const CODEX_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;
function resolveCodexSystemPromptContribution(params) {
	return resolveGpt5SystemPromptContribution(params);
}
function renderCodexPromptOverlay(params) {
	return renderGpt5PromptOverlay(params);
}
//#endregion
export { renderCodexPromptOverlay as n, resolveCodexSystemPromptContribution as r, CODEX_GPT5_BEHAVIOR_CONTRACT as t };
