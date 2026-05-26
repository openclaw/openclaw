import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { randomUUID } from "node:crypto";
//#region src/agents/bash-tools.exec-approval-followup-state.ts
const EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX = "exec-approval-followup:";
const EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_NONCE_MARKER = ":nonce:";
const EXEC_APPROVAL_FOLLOWUP_RUNTIME_HANDOFF_TTL_MS = 300 * 1e3;
const execApprovalFollowupRuntimeHandoffs = /* @__PURE__ */ new Map();
function cloneExecElevatedDefaults(value) {
	return {
		enabled: value.enabled,
		allowed: value.allowed,
		defaultLevel: value.defaultLevel,
		...value.fullAccessAvailable !== void 0 ? { fullAccessAvailable: value.fullAccessAvailable } : {},
		...value.fullAccessBlockedReason !== void 0 ? { fullAccessBlockedReason: value.fullAccessBlockedReason } : {}
	};
}
function cloneExecApprovalFollowupRuntimeHandoff(value) {
	return {
		kind: value.kind,
		approvalId: value.approvalId,
		sessionKey: value.sessionKey,
		idempotencyKey: value.idempotencyKey,
		bashElevated: cloneExecElevatedDefaults(value.bashElevated)
	};
}
function pruneExpiredExecApprovalFollowupRuntimeHandoffs(nowMs) {
	for (const [handoffId, entry] of execApprovalFollowupRuntimeHandoffs) if (entry.expiresAtMs <= nowMs) execApprovalFollowupRuntimeHandoffs.delete(handoffId);
}
function buildExecApprovalFollowupIdempotencyKey(params) {
	const base = `${EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX}${params.approvalId}`;
	const nonce = normalizeOptionalString(params.nonce);
	return nonce ? `${base}${EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_NONCE_MARKER}${nonce}` : base;
}
function parseExecApprovalFollowupApprovalId(idempotencyKey) {
	const normalized = normalizeOptionalString(idempotencyKey);
	if (!normalized?.startsWith(EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX)) return;
	const body = normalized.slice(23);
	const nonceMarker = body.lastIndexOf(EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_NONCE_MARKER);
	return normalizeOptionalString(nonceMarker >= 0 ? body.slice(0, nonceMarker) : body);
}
function registerExecApprovalFollowupRuntimeHandoff(params) {
	const approvalId = normalizeOptionalString(params.approvalId);
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!approvalId || !sessionKey || !params.bashElevated) return;
	const nowMs = params.nowMs ?? Date.now();
	pruneExpiredExecApprovalFollowupRuntimeHandoffs(nowMs);
	const handoffId = randomUUID();
	const idempotencyKey = buildExecApprovalFollowupIdempotencyKey({
		approvalId,
		nonce: randomUUID()
	});
	execApprovalFollowupRuntimeHandoffs.set(handoffId, {
		kind: "exec-approval-followup",
		approvalId,
		sessionKey,
		idempotencyKey,
		bashElevated: cloneExecElevatedDefaults(params.bashElevated),
		expiresAtMs: nowMs + EXEC_APPROVAL_FOLLOWUP_RUNTIME_HANDOFF_TTL_MS
	});
	return {
		handoffId,
		idempotencyKey
	};
}
function consumeExecApprovalFollowupRuntimeHandoff(params) {
	const handoffId = normalizeOptionalString(params.handoffId);
	const approvalId = normalizeOptionalString(params.approvalId);
	const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
	if (!handoffId || !approvalId || !idempotencyKey) return;
	const nowMs = params.nowMs ?? Date.now();
	pruneExpiredExecApprovalFollowupRuntimeHandoffs(nowMs);
	const entry = execApprovalFollowupRuntimeHandoffs.get(handoffId);
	if (!entry) return;
	if (entry.expiresAtMs <= nowMs) {
		execApprovalFollowupRuntimeHandoffs.delete(handoffId);
		return;
	}
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (entry.approvalId !== approvalId || entry.idempotencyKey !== idempotencyKey || entry.sessionKey !== sessionKey) return;
	execApprovalFollowupRuntimeHandoffs.delete(handoffId);
	return cloneExecApprovalFollowupRuntimeHandoff(entry);
}
//#endregion
export { registerExecApprovalFollowupRuntimeHandoff as i, consumeExecApprovalFollowupRuntimeHandoff as n, parseExecApprovalFollowupApprovalId as r, buildExecApprovalFollowupIdempotencyKey as t };
