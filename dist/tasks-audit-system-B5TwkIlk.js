import { F as getTaskFlowRegistryRestoreFailure, I as listTaskFlowRecords, m as listTasksForFlowId } from "./task-registry-B9ljq8Nk.js";
import "./runtime-internal-2F71tA3B.js";
import { t as compareTaskAuditFindingSortKeys } from "./task-registry.audit.shared-CycXrHpp.js";
import { r as summarizeTaskAuditFindings } from "./task-registry.audit-DBGEzaF4.js";
//#region src/tasks/task-flow-registry.audit.ts
const DEFAULT_STALE_RUNNING_MS = 30 * 6e4;
const DEFAULT_STALE_WAITING_MS = 30 * 6e4;
const DEFAULT_STALE_BLOCKED_MS = 30 * 6e4;
const DEFAULT_CANCEL_STUCK_MS = 5 * 6e4;
function createFinding(params) {
	return {
		severity: params.severity,
		code: params.code,
		detail: params.detail,
		...typeof params.ageMs === "number" ? { ageMs: params.ageMs } : {},
		...params.flow ? { flow: params.flow } : {}
	};
}
function severityRank(severity) {
	return severity === "error" ? 0 : 1;
}
function compareFindings(left, right) {
	const severityDiff = severityRank(left.severity) - severityRank(right.severity);
	if (severityDiff !== 0) return severityDiff;
	const leftAge = left.ageMs ?? -1;
	const rightAge = right.ageMs ?? -1;
	if (leftAge !== rightAge) return rightAge - leftAge;
	return (left.flow?.createdAt ?? 0) - (right.flow?.createdAt ?? 0);
}
function getReferenceAt(flow) {
	return flow.updatedAt ?? flow.createdAt;
}
function getLinkedTasks(flowId) {
	return listTasksForFlowId(flowId);
}
function hasBlockingMetadata(flow) {
	return Boolean(flow.blockedTaskId?.trim() || flow.blockedSummary?.trim() || flow.waitJson != null);
}
function findTimestampInconsistency(flow) {
	if (flow.updatedAt < flow.createdAt) return createFinding({
		severity: "warn",
		code: "inconsistent_timestamps",
		flow,
		detail: "updatedAt is earlier than createdAt"
	});
	if (flow.endedAt && flow.endedAt < flow.createdAt) return createFinding({
		severity: "warn",
		code: "inconsistent_timestamps",
		flow,
		detail: "endedAt is earlier than createdAt"
	});
	if (flow.endedAt && flow.endedAt < flow.updatedAt) return createFinding({
		severity: "warn",
		code: "inconsistent_timestamps",
		flow,
		detail: "endedAt is earlier than updatedAt"
	});
	return null;
}
function createEmptyTaskFlowAuditSummary() {
	return {
		total: 0,
		warnings: 0,
		errors: 0,
		byCode: {
			restore_failed: 0,
			stale_running: 0,
			stale_waiting: 0,
			stale_blocked: 0,
			cancel_stuck: 0,
			missing_linked_tasks: 0,
			blocked_task_missing: 0,
			inconsistent_timestamps: 0
		}
	};
}
function listTaskFlowAuditFindings(options = {}) {
	const flows = options.flows ?? listTaskFlowRecords();
	const now = options.now ?? Date.now();
	const staleRunningMs = options.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
	const staleWaitingMs = options.staleWaitingMs ?? DEFAULT_STALE_WAITING_MS;
	const staleBlockedMs = options.staleBlockedMs ?? DEFAULT_STALE_BLOCKED_MS;
	const cancelStuckMs = options.cancelStuckMs ?? DEFAULT_CANCEL_STUCK_MS;
	const findings = [];
	const restoreFailure = getTaskFlowRegistryRestoreFailure();
	if (restoreFailure) findings.push(createFinding({
		severity: "error",
		code: "restore_failed",
		detail: `task-flow registry restore failed: ${restoreFailure}`
	}));
	for (const flow of flows) {
		const referenceAt = getReferenceAt(flow);
		const ageMs = Math.max(0, now - referenceAt);
		const linkedTasks = getLinkedTasks(flow.flowId);
		const activeTasks = linkedTasks.filter((task) => task.status === "queued" || task.status === "running");
		if (flow.status === "running" && ageMs >= staleRunningMs) findings.push(createFinding({
			severity: "error",
			code: "stale_running",
			flow,
			ageMs,
			detail: "running TaskFlow has not advanced recently"
		}));
		if (flow.status === "waiting" && ageMs >= staleWaitingMs) findings.push(createFinding({
			severity: "warn",
			code: "stale_waiting",
			flow,
			ageMs,
			detail: "waiting TaskFlow has not advanced recently"
		}));
		if (flow.status === "blocked" && ageMs >= staleBlockedMs) findings.push(createFinding({
			severity: "warn",
			code: "stale_blocked",
			flow,
			ageMs,
			detail: "blocked TaskFlow has not advanced recently"
		}));
		if (flow.cancelRequestedAt != null && flow.status !== "cancelled" && flow.status !== "failed" && flow.status !== "succeeded" && flow.status !== "lost" && activeTasks.length === 0 && now - flow.cancelRequestedAt >= cancelStuckMs) findings.push(createFinding({
			severity: "warn",
			code: "cancel_stuck",
			flow,
			ageMs: Math.max(0, now - flow.cancelRequestedAt),
			detail: "cancel-requested TaskFlow has no active child tasks but is still nonterminal"
		}));
		if (flow.syncMode === "managed" && (flow.status === "running" || flow.status === "waiting" || flow.status === "blocked") && ageMs >= (flow.status === "running" ? staleRunningMs : flow.status === "waiting" ? staleWaitingMs : staleBlockedMs) && linkedTasks.length === 0 && !hasBlockingMetadata(flow)) findings.push(createFinding({
			severity: flow.status === "running" ? "error" : "warn",
			code: "missing_linked_tasks",
			flow,
			ageMs,
			detail: "managed TaskFlow has no linked tasks or wait state"
		}));
		if (flow.blockedTaskId?.trim()) {
			const blockedTaskId = flow.blockedTaskId.trim();
			if (!linkedTasks.some((task) => task.taskId === blockedTaskId)) findings.push(createFinding({
				severity: "warn",
				code: "blocked_task_missing",
				flow,
				ageMs,
				detail: `blocked TaskFlow points at missing task ${blockedTaskId}`
			}));
		}
		const inconsistency = findTimestampInconsistency(flow);
		if (inconsistency) findings.push(inconsistency);
	}
	return findings.toSorted(compareFindings);
}
function summarizeTaskFlowAuditFindings(findings) {
	const summary = createEmptyTaskFlowAuditSummary();
	for (const finding of findings) {
		summary.total += 1;
		summary.byCode[finding.code] += 1;
		if (finding.severity === "error") summary.errors += 1;
		else summary.warnings += 1;
	}
	return summary;
}
//#endregion
//#region src/commands/tasks-audit-system.ts
function compareSystemAuditFindings(left, right) {
	return compareTaskAuditFindingSortKeys({
		severity: left.severity,
		ageMs: left.ageMs,
		createdAt: left.task?.createdAt ?? left.flow?.createdAt ?? 0
	}, {
		severity: right.severity,
		ageMs: right.ageMs,
		createdAt: right.task?.createdAt ?? right.flow?.createdAt ?? 0
	});
}
function buildTaskSystemAuditFindings(params) {
	const allFindings = [...params.taskFindings.map((finding) => ({
		kind: "task",
		severity: finding.severity,
		code: finding.code,
		detail: finding.detail,
		ageMs: finding.ageMs,
		status: finding.task.status,
		token: finding.task.taskId,
		task: finding.task
	})), ...params.flowFindings.map((finding) => ({
		kind: "task_flow",
		severity: finding.severity,
		code: finding.code,
		detail: finding.detail,
		ageMs: finding.ageMs,
		status: finding.flow?.status ?? "n/a",
		token: finding.flow?.flowId,
		...finding.flow ? { flow: finding.flow } : {}
	}))];
	const filteredFindings = allFindings.filter((finding) => {
		if (params.severityFilter && finding.severity !== params.severityFilter) return false;
		if (params.codeFilter && finding.code !== params.codeFilter) return false;
		return true;
	}).toSorted(compareSystemAuditFindings);
	const sortedAllFindings = [...allFindings].toSorted(compareSystemAuditFindings);
	return {
		allFindings: sortedAllFindings,
		filteredFindings,
		taskFindings: params.taskFindings,
		flowFindings: params.flowFindings,
		summary: {
			total: sortedAllFindings.length,
			errors: sortedAllFindings.filter((finding) => finding.severity === "error").length,
			warnings: sortedAllFindings.filter((finding) => finding.severity !== "error").length,
			tasks: summarizeTaskAuditFindings(params.taskFindings),
			taskFlows: summarizeTaskFlowAuditFindings(params.flowFindings)
		}
	};
}
//#endregion
export { listTaskFlowAuditFindings as n, summarizeTaskFlowAuditFindings as r, buildTaskSystemAuditFindings as t };
