import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import "./agent-scope-rw2bYM9R.js";
import { c as normalizeAgentId } from "./session-key-CQewiu8n.js";
import { c as resolveDefaultAgentId, r as resolveAgentConfig, t as listAgentEntries } from "./agent-scope-config-DdvF1onI.js";
import { t as parseDurationMs } from "./parse-duration-uY-hZbbn.js";
import { c as resolveHeartbeatPrompt } from "./heartbeat-Dwk0vIKl.js";
//#region src/agents/heartbeat-system-prompt.ts
function resolveHeartbeatConfigForSystemPrompt(config, agentId) {
	const defaults = config?.agents?.defaults?.heartbeat;
	if (!config || !agentId) return defaults;
	const overrides = resolveAgentConfig(config, agentId)?.heartbeat;
	if (!defaults && !overrides) return overrides;
	return {
		...defaults,
		...overrides
	};
}
function isHeartbeatEnabledByAgentPolicy(config, agentId) {
	const resolvedAgentId = normalizeAgentId(agentId);
	const agents = listAgentEntries(config);
	if (agents.some((entry) => Boolean(entry?.heartbeat))) return agents.some((entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry.id) === resolvedAgentId);
	return resolvedAgentId === resolveDefaultAgentId(config);
}
function isHeartbeatCadenceEnabled(heartbeat) {
	const trimmedEvery = normalizeOptionalString(heartbeat?.every ?? "30m") ?? "";
	if (!trimmedEvery) return false;
	try {
		return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
	} catch {
		return false;
	}
}
function shouldIncludeHeartbeatGuidanceForSystemPrompt(params) {
	const defaultAgentId = params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
	const agentId = params.agentId ?? defaultAgentId;
	if (!agentId || normalizeAgentId(agentId) !== normalizeAgentId(defaultAgentId)) return false;
	if (params.config && !isHeartbeatEnabledByAgentPolicy(params.config, agentId)) return false;
	const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
	if (heartbeat?.includeSystemPromptSection === false) return false;
	return isHeartbeatCadenceEnabled(heartbeat);
}
function resolveHeartbeatPromptForSystemPrompt(params) {
	const agentId = params.agentId ?? params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
	const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
	if (!shouldIncludeHeartbeatGuidanceForSystemPrompt(params)) return;
	return resolveHeartbeatPrompt(heartbeat?.prompt);
}
//#endregion
export { shouldIncludeHeartbeatGuidanceForSystemPrompt as n, resolveHeartbeatPromptForSystemPrompt as t };
