import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { a as sanitizeTaskStatusText } from "./task-status-BvwcU8qI.js";
import { M as subagentRuns, l as countPendingDescendantRunsFromRuns, t as getSubagentRunsSnapshotForRead } from "./subagent-registry-state-DbOPrqYx.js";
import { t as formatDurationCompact } from "./format-duration-BrZ-AaEJ.js";
import { i as findTaskByRunIdForOwner } from "./task-owner-access-MrVYMLx_.js";
import { i as resolveSubagentTargetFromRuns, n as formatRunStatus, t as formatRunLabel } from "./subagents-utils-B4IBbOXw.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
//#region src/auto-reply/reply/commands-subagents/action-info.ts
const RECENT_WINDOW_MINUTES = 30;
function stopWithText(text) {
	return {
		shouldContinue: false,
		reply: { text }
	};
}
function formatTimestamp(valueMs) {
	if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) return "n/a";
	return new Date(valueMs).toISOString();
}
function formatTimestampWithAge(valueMs) {
	if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) return "n/a";
	return `${formatTimestamp(valueMs)} (${formatTimeAgo(Date.now() - valueMs, { fallback: "n/a" })})`;
}
function resolveDisplayStatus(entry, options) {
	const pendingDescendants = Math.max(0, options?.pendingDescendants ?? 0);
	if (pendingDescendants > 0) return `active (waiting on ${pendingDescendants} ${pendingDescendants === 1 ? "child" : "children"})`;
	const status = formatRunStatus(entry);
	return status === "error" ? "failed" : status;
}
function resolveSubagentEntryForToken(runs, token) {
	const resolved = resolveSubagentTargetFromRuns({
		runs,
		token,
		recentWindowMinutes: RECENT_WINDOW_MINUTES,
		label: (entry) => formatRunLabel(entry),
		aliases: (entry) => entry.taskName ? [entry.taskName] : [],
		isActive: (entry) => !entry.endedAt || Math.max(0, countPendingDescendantRunsFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), entry.childSessionKey)) > 0,
		errors: {
			missingTarget: "Missing subagent id.",
			invalidIndex: (value) => `Invalid subagent index: ${value}`,
			unknownSession: (value) => `Unknown subagent session: ${value}`,
			ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
			ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
			ambiguousRunIdPrefix: (value) => `Ambiguous run id prefix: ${value}`,
			unknownTarget: (value) => `Unknown subagent id: ${value}`
		}
	});
	if (!resolved.entry) return { reply: stopWithText(`⚠️ ${resolved.error ?? "Unknown subagent."}`) };
	return { entry: resolved.entry };
}
function loadSubagentSessionEntry(params, childKey) {
	const parsed = parseAgentSessionKey(childKey);
	return { entry: loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId }))[childKey] };
}
function handleSubagentsInfoAction(ctx) {
	const { params, requesterKey, runs, restTokens } = ctx;
	const target = restTokens[0];
	if (!target) return stopWithText("ℹ️ Usage: /subagents info <id|#>");
	const targetResolution = resolveSubagentEntryForToken(runs, target);
	if ("reply" in targetResolution) return targetResolution.reply;
	const run = targetResolution.entry;
	const { entry: sessionEntry } = loadSubagentSessionEntry(params, run.childSessionKey);
	const runtime = run.startedAt && Number.isFinite(run.startedAt) ? formatDurationCompact((run.endedAt ?? Date.now()) - run.startedAt) ?? "n/a" : "n/a";
	const outcomeError = sanitizeTaskStatusText(run.outcome?.error, { errorContext: true });
	const outcome = run.outcome ? `${run.outcome.status}${outcomeError ? ` (${outcomeError})` : ""}` : "n/a";
	const linkedTask = findTaskByRunIdForOwner({
		runId: run.runId,
		callerOwnerKey: requesterKey
	});
	const taskText = sanitizeTaskStatusText(run.task) || "n/a";
	const progressText = sanitizeTaskStatusText(linkedTask?.progressSummary);
	const taskSummaryText = sanitizeTaskStatusText(linkedTask?.terminalSummary, { errorContext: true });
	const taskErrorText = sanitizeTaskStatusText(linkedTask?.error, { errorContext: true });
	return stopWithText([
		"ℹ️ Subagent info",
		`Status: ${resolveDisplayStatus(run, { pendingDescendants: countPendingDescendantRunsFromRuns(getSubagentRunsSnapshotForRead(subagentRuns), run.childSessionKey) })}`,
		`Label: ${formatRunLabel(run)}`,
		`Task: ${taskText}`,
		`Run: ${run.runId}`,
		linkedTask ? `TaskId: ${linkedTask.taskId}` : void 0,
		linkedTask ? `TaskStatus: ${linkedTask.status}` : void 0,
		`Session: ${run.childSessionKey}`,
		`SessionId: ${sessionEntry?.sessionId ?? "n/a"}`,
		`Transcript: ${sessionEntry?.sessionFile ?? "n/a"}`,
		`Runtime: ${runtime}`,
		`Created: ${formatTimestampWithAge(run.createdAt)}`,
		`Started: ${formatTimestampWithAge(run.startedAt)}`,
		`Ended: ${formatTimestampWithAge(run.endedAt)}`,
		`Cleanup: ${run.cleanup}`,
		run.archiveAtMs ? `Archive: ${formatTimestampWithAge(run.archiveAtMs)}` : void 0,
		run.cleanupHandled ? "Cleanup handled: yes" : void 0,
		`Outcome: ${outcome}`,
		progressText ? `Progress: ${progressText}` : void 0,
		taskSummaryText ? `Task summary: ${taskSummaryText}` : void 0,
		taskErrorText ? `Task error: ${taskErrorText}` : void 0,
		linkedTask ? `Delivery: ${linkedTask.deliveryStatus}` : void 0
	].filter(Boolean).join("\n"));
}
//#endregion
export { handleSubagentsInfoAction };
