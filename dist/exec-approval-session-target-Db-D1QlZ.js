import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { r as normalizeOptionalAccountId } from "./account-id-B32J-iNN.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore, w as resolveMaintenanceConfigFromInput } from "./store-load-z4thf6ld.js";
import { n as resolveSessionConversationRef } from "./session-conversation-XHNnUnBT.js";
import { t as resolveSessionDeliveryTarget } from "./targets-session-B-pkKm7E.js";
import "./targets-CNDTJ9IB.js";
//#region src/infra/approval-request-account-binding.ts
function normalizeOptionalChannel$1(value) {
	return normalizeMessageChannel(value);
}
function resolvePersistedApprovalRequestSessionEntry(params) {
	const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
	if (!sessionKey) return null;
	const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? params.request.request.agentId ?? "main";
	const entry = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId }), { maintenanceConfig: resolveMaintenanceConfigFromInput(params.cfg.session?.maintenance) })[sessionKey];
	if (!entry) return null;
	return {
		sessionKey,
		entry
	};
}
function resolvePersistedApprovalRequestSessionBinding(params) {
	const persisted = resolvePersistedApprovalRequestSessionEntry(params);
	if (!persisted) return null;
	const { entry } = persisted;
	const channel = normalizeOptionalChannel$1(entry.origin?.provider ?? entry.lastChannel);
	const accountId = normalizeOptionalAccountId(entry.origin?.accountId ?? entry.lastAccountId);
	return channel || accountId ? {
		channel,
		accountId
	} : null;
}
function resolveApprovalRequestAccountId(params) {
	const expectedChannel = normalizeOptionalChannel$1(params.channel);
	const turnSourceChannel = normalizeOptionalChannel$1(params.request.request.turnSourceChannel);
	if (expectedChannel && turnSourceChannel && turnSourceChannel !== expectedChannel) return null;
	const turnSourceAccountId = normalizeOptionalAccountId(params.request.request.turnSourceAccountId);
	if (turnSourceAccountId) return turnSourceAccountId;
	const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
	const sessionChannel = sessionBinding?.channel;
	if (expectedChannel && sessionChannel && sessionChannel !== expectedChannel) return null;
	return sessionBinding?.accountId ?? null;
}
function resolveApprovalRequestChannelAccountId(params) {
	const expectedChannel = normalizeOptionalChannel$1(params.channel);
	if (!expectedChannel) return null;
	const turnSourceChannel = normalizeOptionalChannel$1(params.request.request.turnSourceChannel);
	if (!turnSourceChannel || turnSourceChannel === expectedChannel) return resolveApprovalRequestAccountId(params);
	const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
	return sessionBinding?.channel === expectedChannel ? sessionBinding.accountId ?? null : null;
}
function doesApprovalRequestMatchChannelAccount(params) {
	const expectedChannel = normalizeOptionalChannel$1(params.channel);
	if (!expectedChannel) return false;
	const turnSourceChannel = normalizeOptionalChannel$1(params.request.request.turnSourceChannel);
	if (turnSourceChannel && turnSourceChannel !== expectedChannel) return false;
	const turnSourceAccountId = normalizeOptionalAccountId(params.request.request.turnSourceAccountId);
	const expectedAccountId = normalizeOptionalAccountId(params.accountId);
	if (turnSourceAccountId) return !expectedAccountId || expectedAccountId === turnSourceAccountId;
	const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
	const sessionChannel = sessionBinding?.channel;
	if (sessionChannel && sessionChannel !== expectedChannel) return false;
	const boundAccountId = sessionBinding?.accountId;
	return !expectedAccountId || !boundAccountId || expectedAccountId === boundAccountId;
}
//#endregion
//#region src/infra/exec-approval-session-target.ts
function normalizeOptionalThreadValue(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value !== "string") return;
	const normalized = value.trim();
	return normalized ? normalized : void 0;
}
function isExecApprovalRequest(request) {
	return "command" in request.request;
}
function toExecLikeApprovalRequest(request) {
	if (isExecApprovalRequest(request)) return request;
	return {
		id: request.id,
		request: {
			command: request.request.title,
			sessionKey: request.request.sessionKey ?? void 0,
			turnSourceChannel: request.request.turnSourceChannel ?? void 0,
			turnSourceTo: request.request.turnSourceTo ?? void 0,
			turnSourceAccountId: request.request.turnSourceAccountId ?? void 0,
			turnSourceThreadId: request.request.turnSourceThreadId ?? void 0
		},
		createdAtMs: request.createdAtMs,
		expiresAtMs: request.expiresAtMs
	};
}
function normalizeOptionalChannel(value) {
	return normalizeMessageChannel(value);
}
function resolveApprovalRequestSessionConversation(params) {
	const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
	if (!sessionKey) return null;
	const resolved = resolveSessionConversationRef(sessionKey, { bundledFallback: params.bundledFallback });
	if (!resolved) return null;
	const expectedChannel = normalizeOptionalChannel(params.channel);
	if (expectedChannel && normalizeOptionalChannel(resolved.channel) !== expectedChannel) return null;
	return {
		channel: resolved.channel,
		kind: resolved.kind,
		id: resolved.id,
		rawId: resolved.rawId,
		threadId: resolved.threadId,
		baseSessionKey: resolved.baseSessionKey,
		baseConversationId: resolved.baseConversationId,
		parentConversationCandidates: resolved.parentConversationCandidates
	};
}
function resolveExecApprovalSessionTarget(params) {
	if (!normalizeOptionalString(params.request.request.sessionKey)) return null;
	const persisted = resolvePersistedApprovalRequestSessionEntry({
		cfg: params.cfg,
		request: params.request
	});
	if (!persisted) return null;
	const target = resolveSessionDeliveryTarget({
		entry: persisted.entry,
		requestedChannel: "last",
		turnSourceChannel: normalizeOptionalString(params.turnSourceChannel),
		turnSourceTo: normalizeOptionalString(params.turnSourceTo),
		turnSourceAccountId: normalizeOptionalString(params.turnSourceAccountId),
		turnSourceThreadId: normalizeOptionalThreadValue(params.turnSourceThreadId)
	});
	if (!target.to) return null;
	return {
		channel: normalizeOptionalString(target.channel),
		to: target.to,
		accountId: normalizeOptionalString(target.accountId),
		threadId: normalizeOptionalThreadValue(target.threadId)
	};
}
function resolveApprovalRequestSessionTarget(params) {
	const execLikeRequest = toExecLikeApprovalRequest(params.request);
	return resolveExecApprovalSessionTarget({
		cfg: params.cfg,
		request: execLikeRequest,
		turnSourceChannel: execLikeRequest.request.turnSourceChannel ?? void 0,
		turnSourceTo: execLikeRequest.request.turnSourceTo ?? void 0,
		turnSourceAccountId: execLikeRequest.request.turnSourceAccountId ?? void 0,
		turnSourceThreadId: execLikeRequest.request.turnSourceThreadId ?? void 0
	});
}
function resolveApprovalRequestStoredSessionTarget(params) {
	const execLikeRequest = toExecLikeApprovalRequest(params.request);
	return resolveExecApprovalSessionTarget({
		cfg: params.cfg,
		request: execLikeRequest
	});
}
function resolveApprovalRequestOriginTarget(params) {
	if (!doesApprovalRequestMatchChannelAccount({
		cfg: params.cfg,
		request: params.request,
		channel: params.channel,
		accountId: params.accountId
	})) return null;
	const turnSourceTarget = params.resolveTurnSourceTarget(params.request);
	const expectedChannel = normalizeOptionalChannel(params.channel);
	const sessionTargetBinding = resolveApprovalRequestStoredSessionTarget({
		cfg: params.cfg,
		request: params.request
	});
	const sessionTarget = sessionTargetBinding && normalizeOptionalChannel(sessionTargetBinding.channel) === expectedChannel ? params.resolveSessionTarget(sessionTargetBinding) : null;
	if (turnSourceTarget && sessionTarget && !params.targetsMatch(turnSourceTarget, sessionTarget)) return null;
	return turnSourceTarget ?? sessionTarget ?? params.resolveFallbackTarget?.(params.request) ?? null;
}
//#endregion
export { doesApprovalRequestMatchChannelAccount as a, resolveExecApprovalSessionTarget as i, resolveApprovalRequestSessionConversation as n, resolveApprovalRequestAccountId as o, resolveApprovalRequestSessionTarget as r, resolveApprovalRequestChannelAccountId as s, resolveApprovalRequestOriginTarget as t };
