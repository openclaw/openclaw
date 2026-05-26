import { i as GPT5_HEARTBEAT_PROMPT_OVERLAY, l as resolveGpt5SystemPromptContribution, s as renderGpt5PromptOverlay, t as GPT5_BEHAVIOR_CONTRACT } from "./gpt5-prompt-overlay-CCXWkJ2o.js";
import "./provider-model-shared-D-slKnZa.js";
//#region extensions/codex/prompt-overlay.ts
const CODEX_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;
const CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY = GPT5_HEARTBEAT_PROMPT_OVERLAY;
function resolveCodexSystemPromptContribution(params) {
	return resolveGpt5SystemPromptContribution(params);
}
function renderCodexPromptOverlay(params) {
	return renderGpt5PromptOverlay(params);
}
//#endregion
export { resolveCodexSystemPromptContribution as i, CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY as n, renderCodexPromptOverlay as r, CODEX_GPT5_BEHAVIOR_CONTRACT as t };
