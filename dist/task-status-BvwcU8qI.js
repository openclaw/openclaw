import { y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import { t as INTERNAL_RUNTIME_CONTEXT_BEGIN } from "./internal-runtime-context-DWxvZFcB.js";
import { d as sanitizeUserFacingText } from "./sanitize-user-facing-text-Df1D-hzs.js";
//#region src/tasks/task-status.ts
const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const FAILURE_TASK_STATUSES = new Set([
	"failed",
	"timed_out",
	"lost"
]);
const TASK_STATUS_RECENT_WINDOW_MS = 5 * 6e4;
function isActiveTask(task) {
	return ACTIVE_TASK_STATUSES.has(task.status);
}
function isFailureTask(task) {
	return FAILURE_TASK_STATUSES.has(task.status);
}
function resolveTaskReferenceAt(task) {
	if (isActiveTask(task)) return task.lastEventAt ?? task.startedAt ?? task.createdAt;
	return task.endedAt ?? task.lastEventAt ?? task.startedAt ?? task.createdAt;
}
function isExpiredTask(task, now) {
	return typeof task.cleanupAfter === "number" && task.cleanupAfter <= now;
}
function isRecentTerminalTask(task, now) {
	if (isActiveTask(task)) return false;
	return now - resolveTaskReferenceAt(task) <= TASK_STATUS_RECENT_WINDOW_MS;
}
function truncateTaskStatusText(value, maxChars) {
	const trimmed = value.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
function stripInlineLeakedInternalContext(value) {
	const beginIndex = value.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN);
	if (beginIndex !== -1 && (value.includes("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>") || value.includes("OpenClaw runtime context (internal):") || value.includes("[Internal task completion event]"))) return value.slice(0, beginIndex);
	const legacyHeaderIndex = value.indexOf("OpenClaw runtime context (internal):");
	if (legacyHeaderIndex !== -1 && (value.includes("Keep internal details private.") || value.includes("[Internal task completion event]"))) return value.slice(0, legacyHeaderIndex);
	return value;
}
function sanitizeTaskStatusValue(value, errorContext) {
	if (typeof value === "string") return sanitizeUserFacingText(stripInlineLeakedInternalContext(value), { errorContext }).replace(/\s+/g, " ").trim() || void 0;
	if (Array.isArray(value)) {
		const next = value.map((entry) => sanitizeTaskStatusValue(entry, errorContext)).filter((entry) => entry !== void 0);
		return next.length > 0 ? next : void 0;
	}
	if (value && typeof value === "object") {
		const nextEntries = Object.entries(value).map(([key, entry]) => [key, sanitizeTaskStatusValue(entry, errorContext)]).filter(([, entry]) => entry !== void 0);
		if (nextEntries.length === 0) return;
		return Object.fromEntries(nextEntries);
	}
	return value;
}
function sanitizeTaskStatusText(value, opts) {
	const sanitizedValue = sanitizeTaskStatusValue(value, opts?.errorContext ?? false);
	const sanitized = (typeof sanitizedValue === "string" ? sanitizedValue : sanitizedValue == null ? "" : JSON.stringify(sanitizedValue) ?? "").replace(/\s+/g, " ").trim();
	if (!sanitized) return "";
	if (typeof opts?.maxChars === "number") return truncateTaskStatusText(sanitized, opts.maxChars);
	return sanitized;
}
function formatTaskStatusTitleText(value, fallback = "Background task") {
	return sanitizeTaskStatusText(value, { maxChars: 80 }) || fallback;
}
function formatTaskStatusTitle(task) {
	return formatTaskStatusTitleText(task.label?.trim() || task.task.trim());
}
function formatTaskStatusDetail(task) {
	if (task.status === "running" || task.status === "queued") return sanitizeTaskStatusText(task.progressSummary, { maxChars: 120 }) || void 0;
	const sanitizedError = sanitizeTaskStatusText(task.error, {
		errorContext: true,
		maxChars: 120
	});
	if (sanitizedError) return sanitizedError;
	return sanitizeTaskStatusText(task.terminalSummary, {
		errorContext: true,
		maxChars: 120
	}) || void 0;
}
function buildTaskStatusSnapshot(tasks, opts) {
	const now = opts?.now ?? Date.now();
	const visibleCandidates = tasks.filter((task) => !isExpiredTask(task, now));
	const active = visibleCandidates.filter(isActiveTask);
	const recentTerminal = visibleCandidates.filter((task) => isRecentTerminalTask(task, now));
	const visible = active.length > 0 ? [...active, ...recentTerminal] : recentTerminal;
	const focus = active[0] ?? recentTerminal.find((task) => isFailureTask(task)) ?? recentTerminal[0];
	return {
		latest: active[0] ?? recentTerminal[0],
		focus,
		visible,
		active,
		recentTerminal,
		activeCount: active.length,
		totalCount: visible.length,
		recentFailureCount: recentTerminal.filter(isFailureTask).length
	};
}
//#endregion
export { sanitizeTaskStatusText as a, formatTaskStatusTitleText as i, formatTaskStatusDetail as n, formatTaskStatusTitle as r, buildTaskStatusSnapshot as t };
