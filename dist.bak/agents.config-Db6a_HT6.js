import { a as resolveAgentDir, d as resolveDefaultAgentId, n as listAgentEntries, u as resolveAgentWorkspaceDir } from "./agent-scope-C2k6BQnt.js";
import { s as normalizeAgentId } from "./session-key-qmb11-mH.js";
import { F as loadAgentIdentityFromWorkspace, P as identityHasValues } from "./subagent-registry-BrzwRDvR.js";

//#region src/commands/agents.config.ts
function findAgentEntryIndex(list, agentId) {
	const id = normalizeAgentId(agentId);
	return list.findIndex((entry) => normalizeAgentId(entry.id) === id);
}
function resolveAgentName(cfg, agentId) {
	return listAgentEntries(cfg).find((agent) => normalizeAgentId(agent.id) === normalizeAgentId(agentId))?.name?.trim() || void 0;
}
function resolveAgentModel(cfg, agentId) {
	const entry = listAgentEntries(cfg).find((agent) => normalizeAgentId(agent.id) === normalizeAgentId(agentId));
	if (entry?.model) {
		if (typeof entry.model === "string" && entry.model.trim()) return entry.model.trim();
		if (typeof entry.model === "object") {
			const primary = entry.model.primary?.trim();
			if (primary) return primary;
		}
	}
	const raw = cfg.agents?.defaults?.model;
	if (typeof raw === "string") return raw;
	return raw?.primary?.trim() || void 0;
}
function loadAgentIdentity(workspace) {
	const parsed = loadAgentIdentityFromWorkspace(workspace);
	if (!parsed) return null;
	return identityHasValues(parsed) ? parsed : null;
}
function buildAgentSummaries(cfg) {
	const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
	const configuredAgents = listAgentEntries(cfg);
	const orderedIds = configuredAgents.length > 0 ? configuredAgents.map((agent) => normalizeAgentId(agent.id)) : [defaultAgentId];
	const bindingCounts = /* @__PURE__ */ new Map();
	for (const binding of cfg.bindings ?? []) {
		const agentId = normalizeAgentId(binding.agentId);
		bindingCounts.set(agentId, (bindingCounts.get(agentId) ?? 0) + 1);
	}
	return orderedIds.filter((id, index) => orderedIds.indexOf(id) === index).map((id) => {
		const workspace = resolveAgentWorkspaceDir(cfg, id);
		const identity = loadAgentIdentity(workspace);
		const configIdentity = configuredAgents.find((agent) => normalizeAgentId(agent.id) === id)?.identity;
		const identityName = identity?.name ?? configIdentity?.name?.trim();
		const identityEmoji = identity?.emoji ?? configIdentity?.emoji?.trim();
		const identitySource = identity ? "identity" : configIdentity && (identityName || identityEmoji) ? "config" : void 0;
		return {
			id,
			name: resolveAgentName(cfg, id),
			identityName,
			identityEmoji,
			identitySource,
			workspace,
			agentDir: resolveAgentDir(cfg, id),
			model: resolveAgentModel(cfg, id),
			bindings: bindingCounts.get(id) ?? 0,
			isDefault: id === defaultAgentId
		};
	});
}
function applyAgentConfig(cfg, params) {
	const agentId = normalizeAgentId(params.agentId);
	const name = params.name?.trim();
	const list = listAgentEntries(cfg);
	const index = findAgentEntryIndex(list, agentId);
	const nextEntry = {
		...index >= 0 ? list[index] : { id: agentId },
		...name ? { name } : {},
		...params.workspace ? { workspace: params.workspace } : {},
		...params.agentDir ? { agentDir: params.agentDir } : {},
		...params.model ? { model: params.model } : {}
	};
	const nextList = [...list];
	if (index >= 0) nextList[index] = nextEntry;
	else {
		if (nextList.length === 0 && agentId !== normalizeAgentId(resolveDefaultAgentId(cfg))) nextList.push({ id: resolveDefaultAgentId(cfg) });
		nextList.push(nextEntry);
	}
	return {
		...cfg,
		agents: {
			...cfg.agents,
			list: nextList
		}
	};
}
function pruneAgentConfig(cfg, agentId) {
	const id = normalizeAgentId(agentId);
	const nextAgentsList = listAgentEntries(cfg).filter((entry) => normalizeAgentId(entry.id) !== id);
	const nextAgents = nextAgentsList.length > 0 ? nextAgentsList : void 0;
	const bindings = cfg.bindings ?? [];
	const filteredBindings = bindings.filter((binding) => normalizeAgentId(binding.agentId) !== id);
	const allow = cfg.tools?.agentToAgent?.allow ?? [];
	const filteredAllow = allow.filter((entry) => entry !== id);
	const nextAgentsConfig = cfg.agents ? {
		...cfg.agents,
		list: nextAgents
	} : nextAgents ? { list: nextAgents } : void 0;
	const nextTools = cfg.tools?.agentToAgent ? {
		...cfg.tools,
		agentToAgent: {
			...cfg.tools.agentToAgent,
			allow: filteredAllow.length > 0 ? filteredAllow : void 0
		}
	} : cfg.tools;
	return {
		config: {
			...cfg,
			agents: nextAgentsConfig,
			bindings: filteredBindings.length > 0 ? filteredBindings : void 0,
			tools: nextTools
		},
		removedBindings: bindings.length - filteredBindings.length,
		removedAllow: allow.length - filteredAllow.length
	};
}

//#endregion
export { pruneAgentConfig as a, loadAgentIdentity as i, buildAgentSummaries as n, findAgentEntryIndex as r, applyAgentConfig as t };