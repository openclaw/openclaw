import { normalizeText } from "../normalize-text.mjs";
//#region src/runtime/session-identity.ts
function normalizeIdentityState(value) {
	if (value !== "pending" && value !== "resolved") return;
	return value;
}
function normalizeIdentitySource(value) {
	if (value !== "ensure" && value !== "status" && value !== "event") return;
	return value;
}
function normalizeIdentity(identity) {
	if (!identity) return;
	const state = normalizeIdentityState(identity.state);
	const source = normalizeIdentitySource(identity.source);
	const acpxRecordId = normalizeText(identity.acpxRecordId);
	const acpxSessionId = normalizeText(identity.acpxSessionId);
	const agentSessionId = normalizeText(identity.agentSessionId);
	const lastUpdatedAt = typeof identity.lastUpdatedAt === "number" && Number.isFinite(identity.lastUpdatedAt) ? identity.lastUpdatedAt : void 0;
	if (!state && !source && !Boolean(acpxRecordId || acpxSessionId || agentSessionId) && lastUpdatedAt === void 0) return;
	return {
		state: state ?? (Boolean(acpxSessionId || agentSessionId) ? "resolved" : "pending"),
		...acpxRecordId ? { acpxRecordId } : {},
		...acpxSessionId ? { acpxSessionId } : {},
		...agentSessionId ? { agentSessionId } : {},
		source: source ?? "status",
		lastUpdatedAt: lastUpdatedAt ?? Date.now()
	};
}
function readIdentityIdsFromHandle(handle) {
	return {
		acpxRecordId: normalizeText(handle.acpxRecordId),
		acpxSessionId: normalizeText(handle.backendSessionId),
		agentSessionId: normalizeText(handle.agentSessionId)
	};
}
function buildSessionIdentity(params) {
	const { acpxRecordId, acpxSessionId, agentSessionId } = params.ids;
	if (!acpxRecordId && !acpxSessionId && !agentSessionId) return;
	return {
		state: params.state,
		...acpxRecordId ? { acpxRecordId } : {},
		...acpxSessionId ? { acpxSessionId } : {},
		...agentSessionId ? { agentSessionId } : {},
		source: params.source,
		lastUpdatedAt: params.now
	};
}
function resolveSessionIdentityFromMeta(meta) {
	if (!meta) return;
	return normalizeIdentity(meta.identity);
}
function identityHasStableSessionId(identity) {
	return Boolean(identity?.acpxSessionId || identity?.agentSessionId);
}
function resolveRuntimeResumeSessionId(identity) {
	if (!identity) return;
	return normalizeText(identity.agentSessionId) ?? normalizeText(identity.acpxSessionId);
}
function isSessionIdentityPending(identity) {
	if (!identity) return true;
	return identity.state === "pending";
}
function identityEquals(left, right) {
	const a = normalizeIdentity(left);
	const b = normalizeIdentity(right);
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.state === b.state && a.acpxRecordId === b.acpxRecordId && a.acpxSessionId === b.acpxSessionId && a.agentSessionId === b.agentSessionId && a.source === b.source;
}
function mergeSessionIdentity(params) {
	const current = normalizeIdentity(params.current);
	const incoming = normalizeIdentity(params.incoming);
	if (!current) {
		if (!incoming) return;
		return {
			...incoming,
			lastUpdatedAt: params.now
		};
	}
	if (!incoming) return current;
	const currentResolved = current.state === "resolved";
	const incomingResolved = incoming.state === "resolved";
	const allowIncomingValue = !currentResolved || incomingResolved;
	const nextRecordId = allowIncomingValue && incoming.acpxRecordId ? incoming.acpxRecordId : current.acpxRecordId;
	const nextAcpxSessionId = allowIncomingValue && incoming.acpxSessionId ? incoming.acpxSessionId : current.acpxSessionId;
	const nextAgentSessionId = allowIncomingValue && incoming.agentSessionId ? incoming.agentSessionId : current.agentSessionId;
	const nextState = Boolean(nextAcpxSessionId || nextAgentSessionId) ? "resolved" : currentResolved ? "resolved" : incoming.state;
	const nextSource = allowIncomingValue ? incoming.source : current.source;
	return {
		state: nextState,
		...nextRecordId ? { acpxRecordId: nextRecordId } : {},
		...nextAcpxSessionId ? { acpxSessionId: nextAcpxSessionId } : {},
		...nextAgentSessionId ? { agentSessionId: nextAgentSessionId } : {},
		source: nextSource,
		lastUpdatedAt: params.now
	};
}
function createIdentityFromEnsure(params) {
	return buildSessionIdentity({
		ids: readIdentityIdsFromHandle(params.handle),
		state: "pending",
		source: "ensure",
		now: params.now
	});
}
function createIdentityFromHandleEvent(params) {
	const ids = readIdentityIdsFromHandle(params.handle);
	return buildSessionIdentity({
		ids,
		state: ids.agentSessionId ? "resolved" : "pending",
		source: "event",
		now: params.now
	});
}
function createIdentityFromStatus(params) {
	if (!params.status) return;
	const details = params.status.details;
	const acpxRecordId = normalizeText(params.status.acpxRecordId) ?? normalizeText(details?.acpxRecordId);
	const acpxSessionId = normalizeText(params.status.backendSessionId) ?? normalizeText(details?.backendSessionId) ?? normalizeText(details?.acpxSessionId);
	const agentSessionId = normalizeText(params.status.agentSessionId) ?? normalizeText(details?.agentSessionId);
	if (!acpxRecordId && !acpxSessionId && !agentSessionId) return;
	return {
		state: Boolean(acpxSessionId || agentSessionId) ? "resolved" : "pending",
		...acpxRecordId ? { acpxRecordId } : {},
		...acpxSessionId ? { acpxSessionId } : {},
		...agentSessionId ? { agentSessionId } : {},
		source: "status",
		lastUpdatedAt: params.now
	};
}
function resolveRuntimeHandleIdentifiersFromIdentity(identity) {
	if (!identity) return {};
	return {
		...identity.acpxSessionId ? { backendSessionId: identity.acpxSessionId } : {},
		...identity.agentSessionId ? { agentSessionId: identity.agentSessionId } : {}
	};
}
//#endregion
export { createIdentityFromEnsure, createIdentityFromHandleEvent, createIdentityFromStatus, identityEquals, identityHasStableSessionId, isSessionIdentityPending, mergeSessionIdentity, resolveRuntimeHandleIdentifiersFromIdentity, resolveRuntimeResumeSessionId, resolveSessionIdentityFromMeta };
