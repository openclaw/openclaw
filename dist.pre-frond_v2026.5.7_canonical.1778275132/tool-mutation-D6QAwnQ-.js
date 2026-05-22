import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { r as asOptionalObjectRecord } from "./record-coerce-BjNW89OI.js";
//#region src/agents/tool-mutation.ts
const MUTATING_TOOL_NAMES = new Set([
	"write",
	"edit",
	"apply_patch",
	"exec",
	"bash",
	"process",
	"message",
	"sessions_spawn",
	"sessions_send",
	"cron",
	"gateway",
	"canvas",
	"nodes",
	"session_status"
]);
const READ_ONLY_ACTIONS = new Set([
	"get",
	"list",
	"read",
	"status",
	"show",
	"fetch",
	"search",
	"query",
	"view",
	"poll",
	"log",
	"inspect",
	"check",
	"probe"
]);
const PROCESS_MUTATING_ACTIONS = new Set([
	"write",
	"send_keys",
	"submit",
	"paste",
	"kill"
]);
const MESSAGE_MUTATING_ACTIONS = new Set([
	"send",
	"reply",
	"thread_reply",
	"threadreply",
	"edit",
	"delete",
	"react",
	"pin",
	"unpin"
]);
function normalizeActionName(value) {
	return normalizeOptionalLowercaseString(value)?.replace(/[\s-]+/g, "_") || void 0;
}
function normalizeFingerprintValue(value) {
	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized ? normalizeLowercaseStringOrEmpty(normalized) : void 0;
	}
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return normalizeLowercaseStringOrEmpty(String(value));
}
function appendFingerprintAlias(parts, record, label, keys) {
	for (const key of keys) {
		const value = normalizeFingerprintValue(record?.[key]);
		if (!value) continue;
		parts.push(`${label}=${value}`);
		return true;
	}
	return false;
}
function isLikelyMutatingToolName(toolName) {
	const normalized = normalizeLowercaseStringOrEmpty(toolName);
	if (!normalized) return false;
	return MUTATING_TOOL_NAMES.has(normalized) || normalized.endsWith("_actions") || normalized.startsWith("message_") || normalized.includes("send");
}
function isMutatingToolCall(toolName, args) {
	const normalized = normalizeLowercaseStringOrEmpty(toolName);
	const record = asOptionalObjectRecord(args);
	const action = normalizeActionName(record?.action);
	switch (normalized) {
		case "write":
		case "edit":
		case "apply_patch":
		case "exec":
		case "bash":
		case "sessions_send": return true;
		case "process": return action != null && PROCESS_MUTATING_ACTIONS.has(action);
		case "message": return action != null && MESSAGE_MUTATING_ACTIONS.has(action) || typeof record?.content === "string" || typeof record?.message === "string";
		case "subagents": return action === "kill" || action === "steer";
		case "session_status": return typeof record?.model === "string" && record.model.trim().length > 0;
		default:
			if (normalized === "cron" || normalized === "gateway" || normalized === "canvas") return action == null || !READ_ONLY_ACTIONS.has(action);
			if (normalized === "nodes") return action == null || action !== "list";
			if (normalized.endsWith("_actions")) return action == null || !READ_ONLY_ACTIONS.has(action);
			if (normalized.startsWith("message_") || normalized.includes("send")) return true;
			return false;
	}
}
function buildToolActionFingerprint(toolName, args, meta) {
	if (!isMutatingToolCall(toolName, args)) return;
	const normalizedTool = normalizeLowercaseStringOrEmpty(toolName);
	const record = asOptionalObjectRecord(args);
	const action = normalizeActionName(record?.action);
	const parts = [`tool=${normalizedTool}`];
	if (action) parts.push(`action=${action}`);
	let hasStableTarget = false;
	hasStableTarget = appendFingerprintAlias(parts, record, "path", [
		"path",
		"file_path",
		"filePath",
		"filepath",
		"file"
	]) || hasStableTarget;
	hasStableTarget = appendFingerprintAlias(parts, record, "oldpath", ["oldPath", "old_path"]) || hasStableTarget;
	hasStableTarget = appendFingerprintAlias(parts, record, "newpath", ["newPath", "new_path"]) || hasStableTarget;
	hasStableTarget = appendFingerprintAlias(parts, record, "to", ["to", "target"]) || hasStableTarget;
	hasStableTarget = appendFingerprintAlias(parts, record, "messageid", ["messageId", "message_id"]) || hasStableTarget;
	hasStableTarget = appendFingerprintAlias(parts, record, "sessionkey", ["sessionKey", "session_key"]) || hasStableTarget;
	hasStableTarget = appendFingerprintAlias(parts, record, "jobid", ["jobId", "job_id"]) || hasStableTarget;
	hasStableTarget = appendFingerprintAlias(parts, record, "id", ["id"]) || hasStableTarget;
	hasStableTarget = appendFingerprintAlias(parts, record, "model", ["model"]) || hasStableTarget;
	const normalizedMeta = normalizeOptionalLowercaseString(meta?.trim().replace(/\s+/g, " "));
	if (normalizedMeta && !hasStableTarget) parts.push(`meta=${normalizedMeta}`);
	return parts.join("|");
}
function buildToolMutationState(toolName, args, meta) {
	const actionFingerprint = buildToolActionFingerprint(toolName, args, meta);
	return {
		mutatingAction: actionFingerprint != null,
		actionFingerprint
	};
}
function isSameToolMutationAction(existing, next) {
	if (existing.actionFingerprint != null || next.actionFingerprint != null) return existing.actionFingerprint != null && next.actionFingerprint != null && existing.actionFingerprint === next.actionFingerprint;
	return existing.toolName === next.toolName && (existing.meta ?? "") === (next.meta ?? "");
}
//#endregion
export { isSameToolMutationAction as i, isLikelyMutatingToolName as n, isMutatingToolCall as r, buildToolMutationState as t };
