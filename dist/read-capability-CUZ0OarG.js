import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./fs-safe-CV86zY9G.js";
import { i as readLocalFileSafely } from "./secure-temp-dir-aidxCRgA.js";
import "./agent-scope-CtLXGcWm.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { n as resolveWorkspaceRoot, r as resolvePathFromInput } from "./workspace-dir-DICx6sb6.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-C9WqMgmG.js";
import { r as resolveGroupToolPolicy } from "./pi-tools.policy-DWPg8MXT.js";
import { i as getAgentScopedMediaLocalRootsForSources, r as getAgentScopedMediaLocalRoots, s as resolveEffectiveToolFsRootExpansionAllowed } from "./local-roots-Pi6a9oaK.js";
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
