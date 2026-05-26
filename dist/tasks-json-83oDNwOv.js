import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { I as listTaskFlowRecords, f as listTaskRecords } from "./task-registry-B9ljq8Nk.js";
import "./runtime-internal-2F71tA3B.js";
import { n as listTaskAuditFindings, r as summarizeTaskAuditFindings } from "./task-registry.audit-DBGEzaF4.js";
import { n as listTaskFlowAuditFindings, t as buildTaskSystemAuditFindings } from "./tasks-audit-system-B5TwkIlk.js";
//#region src/commands/tasks-json.ts
function listTaskJsonRecords() {
	return listTaskRecords();
}
function toSystemAuditFindings(params) {
	const tasks = listTaskJsonRecords();
	const flows = listTaskFlowRecords();
	return buildTaskSystemAuditFindings({
		taskFindings: listTaskAuditFindings({ tasks }),
		flowFindings: listTaskFlowAuditFindings({ flows }),
		severityFilter: params.severityFilter,
		codeFilter: params.codeFilter
	});
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
