import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
import { l as resolveHeartbeatPrompt } from "./heartbeat-6oYmHVVQ.js";
//#region src/infra/heartbeat-summary.ts
const DEFAULT_HEARTBEAT_TARGET = "none";
function hasExplicitHeartbeatAgents(cfg) {
	return (cfg.agents?.list ?? []).some((entry) => Boolean(entry?.heartbeat));
}
function isHeartbeatEnabledForAgent(cfg, agentId) {
	const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
	const list = cfg.agents?.list ?? [];
	if (hasExplicitHeartbeatAgents(cfg)) return list.some((entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === resolvedAgentId);
	if (cfg.agents?.defaults?.heartbeat) return true;
	return resolvedAgentId === resolveDefaultAgentId(cfg);
}
function resolveHeartbeatIntervalMs(cfg, overrideEvery, heartbeat) {
	const raw = overrideEvery ?? heartbeat?.every ?? cfg.agents?.defaults?.heartbeat?.every ?? "30m";
	if (!raw) return null;
	const trimmed = normalizeOptionalString(raw) ?? "";
	if (!trimmed) return null;
	let ms;
	try {
		ms = parseDurationMs(trimmed, { defaultUnit: "m" });
	} catch {
		return null;
	}
	if (ms <= 0) return null;
	return ms;
}
function resolveHeartbeatSummaryForAgent(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.heartbeat;
	const overrides = agentId ? resolveAgentConfig(cfg, agentId)?.heartbeat : void 0;
	if (!isHeartbeatEnabledForAgent(cfg, agentId)) return {
		enabled: false,
		every: "disabled",
		everyMs: null,
		prompt: resolveHeartbeatPrompt(defaults?.prompt),
		target: defaults?.target ?? DEFAULT_HEARTBEAT_TARGET,
		model: defaults?.model,
		ackMaxChars: Math.max(0, defaults?.ackMaxChars ?? 300)
	};
	const merged = defaults || overrides ? {
		...defaults,
		...overrides
	} : void 0;
	return {
		enabled: true,
		every: merged?.every ?? defaults?.every ?? overrides?.every ?? "30m",
		everyMs: resolveHeartbeatIntervalMs(cfg, void 0, merged),
		prompt: resolveHeartbeatPrompt(merged?.prompt ?? defaults?.prompt ?? overrides?.prompt),
		target: merged?.target ?? defaults?.target ?? overrides?.target ?? DEFAULT_HEARTBEAT_TARGET,
		model: merged?.model ?? defaults?.model ?? overrides?.model,
		ackMaxChars: Math.max(0, merged?.ackMaxChars ?? defaults?.ackMaxChars ?? overrides?.ackMaxChars ?? 300)
	};
}
//#endregion
export { resolveHeartbeatIntervalMs as n, resolveHeartbeatSummaryForAgent as r, isHeartbeatEnabledForAgent as t };
