import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { n as listAgentIds } from "./agent-scope-config-CMp71_27.js";
//#region src/commands/doctor/shared/stale-subagent-allowlist.ts
function normalizeOptionalAgentId(value) {
	const trimmed = normalizeOptionalString(value) ?? "";
	if (!trimmed) return;
	return normalizeAgentId(trimmed);
}
function collectConfiguredSubagentTargetIds(cfg) {
	const ids = new Set(listAgentIds(cfg));
	for (const agent of cfg.agents?.list ?? []) {
		if (agent.runtime?.type !== "acp") continue;
		const acpAgent = normalizeOptionalAgentId(agent.runtime.acp?.agent);
		if (acpAgent) ids.add(acpAgent);
	}
	const defaultAcpAgent = normalizeOptionalAgentId(cfg.acp?.defaultAgent);
	if (defaultAcpAgent) ids.add(defaultAcpAgent);
	for (const entry of cfg.acp?.allowedAgents ?? []) {
		if (entry.trim() === "*") continue;
		const acpAgent = normalizeOptionalAgentId(entry);
		if (acpAgent) ids.add(acpAgent);
	}
	return ids;
}
function collectStaleAllowlistEntries(params) {
	if (!Array.isArray(params.allowAgents)) return [];
	const hits = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of params.allowAgents) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed || trimmed === "*") continue;
		const normalizedAgentId = normalizeAgentId(trimmed);
		if (params.configuredTargetIds.has(normalizedAgentId)) continue;
		const key = `${params.pathLabel}:${normalizedAgentId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		hits.push({
			pathLabel: params.pathLabel,
			agentId: trimmed,
			normalizedAgentId
		});
	}
	return hits;
}
function scanStaleSubagentAllowlistReferences(cfg) {
	const configuredTargetIds = collectConfiguredSubagentTargetIds(cfg);
	const hits = [];
	hits.push(...collectStaleAllowlistEntries({
		allowAgents: cfg.agents?.defaults?.subagents?.allowAgents,
		pathLabel: "agents.defaults.subagents.allowAgents",
		configuredTargetIds
	}));
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	for (const [index, agent] of agents.entries()) hits.push(...collectStaleAllowlistEntries({
		allowAgents: agent?.subagents?.allowAgents,
		pathLabel: `agents.list.${index}.subagents.allowAgents`,
		configuredTargetIds
	}));
	return hits;
}
function collectStaleSubagentAllowlistWarnings(params) {
	if (params.hits.length === 0) return [];
	return [...params.hits.map((hit) => `- ${hit.pathLabel}: stale subagent target "${hit.agentId}" is not in the configured agent registry.`), `- Run "${params.doctorFixCommand}" to remove stale subagent target ids, or add a configured agent or ACP target for each intended target.`];
}
function filterAllowAgents(params) {
	return params.allowAgents.filter((entry) => {
		const trimmed = entry.trim();
		return !trimmed || trimmed === "*" || !params.staleTargetIds.has(normalizeAgentId(trimmed));
	});
}
function maybeRepairStaleSubagentAllowlists(cfg) {
	const hits = scanStaleSubagentAllowlistReferences(cfg);
	if (hits.length === 0) return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const hitsByPath = /* @__PURE__ */ new Map();
	for (const hit of hits) hitsByPath.set(hit.pathLabel, [...hitsByPath.get(hit.pathLabel) ?? [], hit]);
	const defaultsHits = hitsByPath.get("agents.defaults.subagents.allowAgents") ?? [];
	if (defaultsHits.length > 0 && Array.isArray(next.agents?.defaults?.subagents?.allowAgents)) {
		const staleTargetIds = new Set(defaultsHits.map((hit) => hit.normalizedAgentId));
		next.agents.defaults.subagents.allowAgents = filterAllowAgents({
			allowAgents: next.agents.defaults.subagents.allowAgents,
			staleTargetIds
		});
	}
	const agents = Array.isArray(next.agents?.list) ? next.agents.list : [];
	for (const [index, agent] of agents.entries()) {
		const pathLabel = `agents.list.${index}.subagents.allowAgents`;
		const agentHits = hitsByPath.get(pathLabel) ?? [];
		if (agentHits.length === 0 || !Array.isArray(agent?.subagents?.allowAgents)) continue;
		const staleTargetIds = new Set(agentHits.map((hit) => hit.normalizedAgentId));
		agent.subagents.allowAgents = filterAllowAgents({
			allowAgents: agent.subagents.allowAgents,
			staleTargetIds
		});
	}
	return {
		config: next,
		changes: [...hitsByPath.entries()].map(([pathLabel, pathHits]) => {
			const ids = pathHits.map((hit) => hit.agentId).join(", ");
			return `- ${pathLabel}: removed ${pathHits.length} stale subagent target id${pathHits.length === 1 ? "" : "s"} (${ids})`;
		})
	};
}
//#endregion
export { maybeRepairStaleSubagentAllowlists as n, scanStaleSubagentAllowlistReferences as r, collectStaleSubagentAllowlistWarnings as t };
