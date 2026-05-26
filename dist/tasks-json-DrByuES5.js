import { r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { F as listTaskFlowRecords, d as listTaskRecords } from "./task-registry-DFUW-xBJ.js";
import "./runtime-internal-Bqu0JS7i.js";
import { t as compareTaskAuditFindingSortKeys } from "./task-registry.audit.shared-DBmoktSk.js";
import { n as listTaskAuditFindings, r as summarizeTaskAuditFindings } from "./task-registry.audit-CSa06qoF.js";
import { n as summarizeTaskFlowAuditFindings, t as listTaskFlowAuditFindings } from "./task-flow-registry.audit-D1g1aVx8.js";
//#region src/commands/tasks-json.ts
function listTaskJsonRecords() {
	return listTaskRecords();
}
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
function toSystemAuditFindings(params) {
	const tasks = listTaskJsonRecords();
	const flows = listTaskFlowRecords();
	const taskFindings = listTaskAuditFindings({ tasks });
	const flowFindings = listTaskFlowAuditFindings({ flows });
	const allFindings = [...taskFindings.map((finding) => ({
		kind: "task",
		severity: finding.severity,
		code: finding.code,
		detail: finding.detail,
		ageMs: finding.ageMs,
		status: finding.task.status,
		token: finding.task.taskId,
		task: finding.task
	})), ...flowFindings.map((finding) => ({
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
		taskFindings,
		summary: {
			total: sortedAllFindings.length,
			errors: sortedAllFindings.filter((finding) => finding.severity === "error").length,
			warnings: sortedAllFindings.filter((finding) => finding.severity !== "error").length,
			taskFlows: summarizeTaskFlowAuditFindings(flowFindings)
		}
	};
}
function buildTasksListJsonPayload(opts) {
	const runtimeFilter = opts.runtime?.trim();
	const statusFilter = opts.status?.trim();
	const tasks = listTaskJsonRecords().filter((task) => {
		if (runtimeFilter && task.runtime !== runtimeFilter) return false;
		if (statusFilter && task.status !== statusFilter) return false;
		return true;
	});
	return {
		count: tasks.length,
		runtime: runtimeFilter ?? null,
		status: statusFilter ?? null,
		tasks
	};
}
function buildTasksAuditJsonPayload(opts) {
	const severityFilter = opts.severity?.trim();
	const codeFilter = opts.code?.trim();
	const { allFindings, filteredFindings, taskFindings, summary } = toSystemAuditFindings({
		severityFilter,
		codeFilter
	});
	const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : void 0;
	const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;
	const legacySummary = summarizeTaskAuditFindings(taskFindings);
	return {
		count: allFindings.length,
		filteredCount: filteredFindings.length,
		displayed: displayed.length,
		filters: {
			severity: severityFilter ?? null,
			code: codeFilter ?? null,
			limit: limit ?? null
		},
		summary: {
			...legacySummary,
			taskFlows: summary.taskFlows,
			combined: {
				total: summary.total,
				errors: summary.errors,
				warnings: summary.warnings
			}
		},
		findings: displayed
	};
}
async function tasksListJsonCommand(opts, runtime) {
	writeRuntimeJson(runtime, buildTasksListJsonPayload(opts));
}
async function tasksAuditJsonCommand(opts, runtime) {
	writeRuntimeJson(runtime, buildTasksAuditJsonPayload(opts));
}
//#endregion
export { tasksAuditJsonCommand, tasksListJsonCommand };
