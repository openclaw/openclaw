import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { t as resolveFirstBoundAccountId } from "./bound-account-read-qnHEyAzX.js";
//#region src/agents/subagent-target-policy.ts
function normalizeAllowAgents(allowAgents) {
	if (!Array.isArray(allowAgents)) return {
		configured: false,
		allowAny: false,
		allowedIds: []
	};
	const allowedIds = allowAgents.map((value) => value.trim()).filter((value) => value && value !== "*").map((value) => normalizeAgentId(value)).filter(Boolean);
	return {
		configured: true,
		allowAny: allowAgents.some((value) => value.trim() === "*"),
		allowedIds: Array.from(new Set(allowedIds)).toSorted((a, b) => a.localeCompare(b))
	};
}
function normalizeConfiguredAgentIds(configuredAgentIds) {
	return new Set((configuredAgentIds ?? []).map((id) => normalizeAgentId(id)).filter(Boolean));
}
function filterConfiguredAllowedIds(params) {
	const configuredIds = normalizeConfiguredAgentIds(params.configuredAgentIds);
	return params.allowedIds.filter((id) => configuredIds.has(id));
}
function resolveSubagentAllowedTargetIds(params) {
	const requesterAgentId = normalizeAgentId(params.requesterAgentId);
	const policy = normalizeAllowAgents(params.allowAgents);
	if (!policy.configured) return {
		allowAny: false,
		allowedIds: requesterAgentId ? [requesterAgentId] : []
	};
	if (policy.allowAny) {
		const configuredIds = Array.from(normalizeConfiguredAgentIds(params.configuredAgentIds));
		if (requesterAgentId) configuredIds.push(requesterAgentId);
		return {
			allowAny: true,
			allowedIds: Array.from(new Set(configuredIds)).toSorted((a, b) => a.localeCompare(b))
		};
	}
	return {
		allowAny: false,
		allowedIds: filterConfiguredAllowedIds({
			allowedIds: policy.allowedIds,
			configuredAgentIds: params.configuredAgentIds
		}).toSorted((a, b) => a.localeCompare(b))
	};
}
function resolveSubagentTargetPolicy(params) {
	const requesterAgentId = normalizeAgentId(params.requesterAgentId);
	const targetAgentId = normalizeAgentId(params.targetAgentId);
	if (!params.requestedAgentId?.trim() && targetAgentId === requesterAgentId) return { ok: true };
	const allowed = resolveSubagentAllowedTargetIds({
		requesterAgentId,
		allowAgents: params.allowAgents,
		configuredAgentIds: params.configuredAgentIds
	});
	if (allowed.allowedIds.includes(targetAgentId)) return { ok: true };
	const allowedText = allowed.allowedIds.length > 0 ? allowed.allowedIds.join(", ") : "none";
	const policy = normalizeAllowAgents(params.allowAgents);
	if (allowed.allowAny || policy.allowedIds.includes(targetAgentId)) return {
		ok: false,
		allowedText,
		error: `agentId "${targetAgentId}" is not in the configured agent registry (allowed: ${allowedText})`
	};
	return {
		ok: false,
		allowedText,
		error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`
	};
}
//#endregion
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
//#region src/agents/spawn-requester-origin.ts
const KIND_PREFIX_TO_CHAT_TYPE = {
	"room:": "channel",
	"channel:": "channel",
	"conversation:": "channel",
	"chat:": "channel",
	"thread:": "channel",
	"topic:": "channel",
	"group:": "group",
	"team:": "group",
	"user:": "direct",
	"dm:": "direct",
	"pm:": "direct"
};
const GENERIC_PREFIX_PATTERN = /^[a-z][a-z0-9_-]*:/i;
function getKindForRequesterPrefix(prefix) {
	return Object.hasOwn(KIND_PREFIX_TO_CHAT_TYPE, prefix) ? KIND_PREFIX_TO_CHAT_TYPE[prefix] : void 0;
}
function normalizeChannelPrefix(channelId) {
	const normalized = channelId?.trim().toLowerCase();
	return normalized ? `${normalized}:` : void 0;
}
function shouldPeelRequesterPrefix(prefix, channelPrefix) {
	return Boolean(getKindForRequesterPrefix(prefix) || prefix === channelPrefix);
}
function inferPeerKindFromBareId(value) {
	if (value.startsWith("@")) return "direct";
	if (value.startsWith("!") || value.startsWith("#")) return "channel";
}
function extractRequesterPeer(channelId, requesterTo) {
	if (!requesterTo) return {};
	const raw = requesterTo.trim();
	if (!raw) return {};
	const channelPrefix = normalizeChannelPrefix(channelId);
	let inferredKind;
	let allowBareIdKindOverride = false;
	let value = raw;
	while (true) {
		const match = GENERIC_PREFIX_PATTERN.exec(value);
		if (!match) break;
		const prefix = match[0].toLowerCase();
		if (!shouldPeelRequesterPrefix(prefix, channelPrefix)) break;
		const kindFromPrefix = getKindForRequesterPrefix(prefix);
		if (kindFromPrefix) inferredKind ??= kindFromPrefix;
		allowBareIdKindOverride ||= prefix === channelPrefix || prefix === "room:";
		value = value.slice(prefix.length).trim();
	}
	const bareIdKind = value ? inferPeerKindFromBareId(value) : void 0;
	if (bareIdKind && (!inferredKind || allowBareIdKindOverride)) inferredKind = bareIdKind;
	return {
		peerId: value || void 0,
		peerKind: inferredKind
	};
}
function resolveRequesterOriginForChild(params) {
	const { peerId: normalizedPeerId, peerKind: inferredPeerKind } = extractRequesterPeer(params.requesterChannel, params.requesterTo);
	const rawPeerIdAlias = params.requesterTo?.trim();
	const boundAccountId = params.requesterChannel && params.targetAgentId !== params.requesterAgentId ? resolveFirstBoundAccountId({
		cfg: params.cfg,
		channelId: params.requesterChannel,
		agentId: params.targetAgentId,
		peerId: normalizedPeerId,
		exactPeerIdAliases: rawPeerIdAlias && rawPeerIdAlias !== normalizedPeerId ? [rawPeerIdAlias] : void 0,
		peerKind: inferredPeerKind,
		groupSpace: params.requesterGroupSpace,
		memberRoleIds: params.requesterMemberRoleIds
	}) : void 0;
	return normalizeDeliveryContext({
		channel: params.requesterChannel,
		accountId: boundAccountId ?? params.requesterAccountId,
		to: params.requesterTo,
		threadId: params.requesterThreadId
	});
}
//#endregion
export { resolveSpawnedWorkspaceInheritance as a, resolveIngressWorkspaceOverrideForSpawnedRun as i, mapToolContextToSpawnedRunMetadata as n, resolveSubagentAllowedTargetIds as o, normalizeSpawnedRunMetadata as r, resolveSubagentTargetPolicy as s, resolveRequesterOriginForChild as t };
