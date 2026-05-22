import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { o as parseAgentSessionKey } from "./session-key-utils-C1mGpjUn.js";
import { c as normalizeAgentId } from "./session-key-BSgfYlBK.js";
import { x as resolveAgentWorkspaceDir } from "./agent-scope-CbabgXwH.js";
//#region src/agents/spawned-context.ts
function normalizeSpawnedRunMetadata(value) {
	return {
		spawnedBy: normalizeOptionalString(value?.spawnedBy),
		groupId: normalizeOptionalString(value?.groupId),
		groupChannel: normalizeOptionalString(value?.groupChannel),
		groupSpace: normalizeOptionalString(value?.groupSpace),
		workspaceDir: normalizeOptionalString(value?.workspaceDir)
	};
}
function mapToolContextToSpawnedRunMetadata(value) {
	return {
		groupId: normalizeOptionalString(value?.agentGroupId),
		groupChannel: normalizeOptionalString(value?.agentGroupChannel),
		groupSpace: normalizeOptionalString(value?.agentGroupSpace),
		workspaceDir: normalizeOptionalString(value?.workspaceDir)
	};
}
function resolveSpawnedWorkspaceInheritance(params) {
	const explicit = normalizeOptionalString(params.explicitWorkspaceDir);
	if (explicit) return explicit;
	const agentId = params.targetAgentId ?? (params.requesterSessionKey ? parseAgentSessionKey(params.requesterSessionKey)?.agentId : void 0);
	return agentId ? resolveAgentWorkspaceDir(params.config, normalizeAgentId(agentId)) : void 0;
}
function resolveIngressWorkspaceOverrideForSpawnedRun(metadata) {
	const normalized = normalizeSpawnedRunMetadata(metadata);
	return normalized.spawnedBy ? normalized.workspaceDir : void 0;
}
//#endregion
export { resolveSpawnedWorkspaceInheritance as i, normalizeSpawnedRunMetadata as n, resolveIngressWorkspaceOverrideForSpawnedRun as r, mapToolContextToSpawnedRunMetadata as t };
