import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import "./fs-safe-D4r8mUJk.js";
import { i as readLocalFileSafely } from "./secure-temp-dir-GC3bO7Qi.js";
import "./agent-scope-rw2bYM9R.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-DdvF1onI.js";
import { n as resolveWorkspaceRoot, r as resolvePathFromInput } from "./workspace-dir-gvzAeR6d.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-BW3iLLB9.js";
import { r as resolveGroupToolPolicy } from "./pi-tools.policy-DR83lbED.js";
import { i as getAgentScopedMediaLocalRootsForSources, r as getAgentScopedMediaLocalRoots, s as resolveEffectiveToolFsRootExpansionAllowed } from "./local-roots-D-1cbtbS.js";
//#region src/media/read-capability.ts
function isAgentScopedHostMediaReadAllowed(params) {
	if (!resolveEffectiveToolFsRootExpansionAllowed({
		cfg: params.cfg,
		agentId: params.agentId
	})) return false;
	const groupPolicy = resolveGroupToolPolicy({
		config: params.cfg,
		sessionKey: params.sessionKey,
		messageProvider: params.messageProvider,
		groupId: params.groupId,
		groupChannel: params.groupChannel,
		groupSpace: params.groupSpace,
		accountId: params.accountId,
		senderId: normalizeOptionalString(params.requesterSenderId),
		senderName: normalizeOptionalString(params.requesterSenderName),
		senderUsername: normalizeOptionalString(params.requesterSenderUsername),
		senderE164: normalizeOptionalString(params.requesterSenderE164)
	});
	if (groupPolicy && !isToolAllowedByPolicies("read", [groupPolicy])) return false;
	return true;
}
function createAgentScopedHostMediaReadFile(params) {
	if (!isAgentScopedHostMediaReadAllowed(params)) return;
	const workspaceRoot = resolveWorkspaceRoot(params.workspaceDir ?? (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : void 0));
	return async (filePath) => {
		return (await readLocalFileSafely({ filePath: resolvePathFromInput(filePath, workspaceRoot) })).buffer;
	};
}
function resolveAgentScopedOutboundMediaAccess(params) {
	const hostMediaReadAllowed = isAgentScopedHostMediaReadAllowed(params);
	const localRoots = params.mediaAccess?.localRoots ?? (hostMediaReadAllowed ? getAgentScopedMediaLocalRootsForSources({
		cfg: params.cfg,
		agentId: params.agentId,
		mediaSources: params.mediaSources
	}) : getAgentScopedMediaLocalRoots(params.cfg, params.agentId));
	const resolvedWorkspaceDir = params.workspaceDir ?? params.mediaAccess?.workspaceDir ?? (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : void 0);
	const readFile = params.mediaAccess?.readFile ?? params.mediaReadFile ?? (hostMediaReadAllowed ? createAgentScopedHostMediaReadFile({
		cfg: params.cfg,
		agentId: params.agentId,
		workspaceDir: resolvedWorkspaceDir,
		sessionKey: params.sessionKey,
		messageProvider: params.messageProvider,
		groupId: params.groupId,
		groupChannel: params.groupChannel,
		groupSpace: params.groupSpace,
		accountId: params.accountId,
		requesterSenderId: params.requesterSenderId,
		requesterSenderName: params.requesterSenderName,
		requesterSenderUsername: params.requesterSenderUsername,
		requesterSenderE164: params.requesterSenderE164
	}) : void 0);
	return {
		...localRoots?.length ? { localRoots } : {},
		...readFile ? { readFile } : {},
		...resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}
	};
}
//#endregion
export { resolveAgentScopedOutboundMediaAccess as t };
