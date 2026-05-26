import { r as resolveAgentConfig } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
//#region src/agents/system-prompt-override.ts
function trimNonEmpty(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function resolveSystemPromptOverride(params) {
	const config = params.config;
	if (!config) return;
	const agentOverride = trimNonEmpty(params.agentId ? resolveAgentConfig(config, params.agentId)?.systemPromptOverride : void 0);
	if (agentOverride) return agentOverride;
	return trimNonEmpty(config.agents?.defaults?.systemPromptOverride);
}
//#endregion
export { resolveSystemPromptOverride as t };
