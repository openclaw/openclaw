import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { randomUUID } from "node:crypto";
//#region src/agents/bash-tools.exec-approval-followup-state.ts
const EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX = "exec-approval-followup:";
const EXEC_APPROVAL_FOLLOWUP_ELEVATED_TOKEN_MARKER = ":elevated:";
const EXEC_APPROVAL_FOLLOWUP_ELEVATED_TTL_MS = 300 * 1e3;
const execApprovalFollowupElevatedDefaults = /* @__PURE__ */ new Map();
function cloneExecElevatedDefaults(value) {
	return {
		enabled: value.enabled,
		allowed: value.allowed,
		defaultLevel: value.defaultLevel,
		...value.fullAccessAvailable !== void 0 ? { fullAccessAvailable: value.fullAccessAvailable } : {},
		...value.fullAccessBlockedReason !== void 0 ? { fullAccessBlockedReason: value.fullAccessBlockedReason } : {}
	};
}
function pruneExpiredExecApprovalFollowupElevatedDefaults(nowMs) {
	for (const [token, entry] of execApprovalFollowupElevatedDefaults) if (entry.expiresAtMs <= nowMs) execApprovalFollowupElevatedDefaults.delete(token);
}
function buildExecApprovalFollowupIdempotencyKey(params) {
	const base = `${EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX}${params.approvalId}`;
	return params.execApprovalFollowupToken ? `${base}${EXEC_APPROVAL_FOLLOWUP_ELEVATED_TOKEN_MARKER}${params.execApprovalFollowupToken}` : base;
}
function parseExecApprovalFollowupToken(idempotencyKey) {
	if (!idempotencyKey.startsWith(EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX)) return;
	const tokenMarker = idempotencyKey.lastIndexOf(EXEC_APPROVAL_FOLLOWUP_ELEVATED_TOKEN_MARKER);
	if (tokenMarker < 23) return;
	return normalizeOptionalString(idempotencyKey.slice(tokenMarker + 10));
}
function registerExecApprovalFollowupElevatedDefaults(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!params.bashElevated || !sessionKey) return;
	const nowMs = params.nowMs ?? Date.now();
	pruneExpiredExecApprovalFollowupElevatedDefaults(nowMs);
	const token = randomUUID();
	execApprovalFollowupElevatedDefaults.set(token, {
		sessionKey,
		bashElevated: cloneExecElevatedDefaults(params.bashElevated),
		expiresAtMs: nowMs + EXEC_APPROVAL_FOLLOWUP_ELEVATED_TTL_MS
	});
	return token;
}
function consumeExecApprovalFollowupElevatedDefaults(params) {
	const token = normalizeOptionalString(params.token);
	if (!token) return;
	const nowMs = params.nowMs ?? Date.now();
	pruneExpiredExecApprovalFollowupElevatedDefaults(nowMs);
	const entry = execApprovalFollowupElevatedDefaults.get(token);
	if (!entry) return;
	if (entry.expiresAtMs <= nowMs) {
		execApprovalFollowupElevatedDefaults.delete(token);
		return;
	}
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (entry.sessionKey !== sessionKey) return;
	execApprovalFollowupElevatedDefaults.delete(token);
	return cloneExecElevatedDefaults(entry.bashElevated);
}
function consumeExecApprovalFollowupElevatedDefaultsFromIdempotencyKey(params) {
	return consumeExecApprovalFollowupElevatedDefaults({
		token: parseExecApprovalFollowupToken(params.idempotencyKey),
		sessionKey: params.sessionKey,
		nowMs: params.nowMs
	});
}
//#endregion
export { consumeExecApprovalFollowupElevatedDefaultsFromIdempotencyKey as n, registerExecApprovalFollowupElevatedDefaults as r, buildExecApprovalFollowupIdempotencyKey as t };
