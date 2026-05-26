import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as isRich, r as theme } from "./theme-D58JpUfy.js";
import { n as info } from "./globals-YU5FjfZK.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import "./config-B6Oplu5W.js";
import { I as listTaskFlowRecords, P as getTaskFlowById, m as listTasksForFlowId, z as resolveTaskFlowForLookupToken } from "./task-registry-B9ljq8Nk.js";
import "./runtime-internal-2F71tA3B.js";
import { l as getFlowTaskSummary, n as cancelFlowById } from "./task-executor-BGVJzIov.js";
//#region src/commands/flows.ts
const ID_PAD = 10;
const STATUS_PAD = 10;
const MODE_PAD = 14;
const REV_PAD = 6;
const CTRL_PAD = 20;
function formatFlowLookupMiss(lookup) {
	return `TaskFlow not found: ${lookup}. Run ${formatCliCommand("openclaw tasks flow list")} to see recent flow ids.`;
}
function truncate(value, maxChars) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 1) return value.slice(0, maxChars);
	return `${value.slice(0, maxChars - 1)}…`;
}
function safeFlowDisplayText(value, maxChars) {
	const sanitized = sanitizeTerminalText(value ?? "").trim();
	if (!sanitized) return "n/a";
	return typeof maxChars === "number" ? truncate(sanitized, maxChars) : sanitized;
}
function shortToken(value, maxChars = ID_PAD) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return "n/a";
	return truncate(trimmed, maxChars);
}
function formatFlowStatusCell(status, rich) {
	const padded = status.padEnd(STATUS_PAD);
	if (!rich) return padded;
	if (status === "succeeded") return theme.success(padded);
	if (status === "failed" || status === "lost") return theme.error(padded);
	if (status === "running") return theme.accentBright(padded);
	if (status === "blocked") return theme.warn(padded);
	return theme.muted(padded);
}
function formatFlowRows(flows, rich) {
	const header = [
		"TaskFlow".padEnd(ID_PAD),
		"Mode".padEnd(MODE_PAD),
		"Status".padEnd(STATUS_PAD),
		"Rev".padEnd(REV_PAD),
		"Controller".padEnd(CTRL_PAD),
		"Tasks".padEnd(14),
		"Goal"
	].join(" ");
	const lines = [rich ? theme.heading(header) : header];
	for (const flow of flows) {
		const taskSummary = getFlowTaskSummary(flow.flowId);
		const counts = `${taskSummary.active} active/${taskSummary.total} total`;
		lines.push([
			shortToken(flow.flowId).padEnd(ID_PAD),
			flow.syncMode.padEnd(MODE_PAD),
			formatFlowStatusCell(flow.status, rich),
			String(flow.revision).padEnd(REV_PAD),
			safeFlowDisplayText(flow.controllerId, CTRL_PAD).padEnd(CTRL_PAD),
			counts.padEnd(14),
			safeFlowDisplayText(flow.goal, 80)
		].join(" "));
	}
	return lines;
}
function formatFlowListSummary(flows) {
	return `${flows.filter((flow) => flow.status === "queued" || flow.status === "running").length} active · ${flows.filter((flow) => flow.status === "blocked").length} blocked · ${flows.filter((flow) => flow.cancelRequestedAt != null).length} cancel-requested · ${flows.length} total`;
}
function summarizeWait(flow) {
	if (flow.waitJson == null) return "n/a";
	if (typeof flow.waitJson === "string" || typeof flow.waitJson === "number" || typeof flow.waitJson === "boolean") return String(flow.waitJson);
	if (Array.isArray(flow.waitJson)) return `array(${flow.waitJson.length})`;
	return Object.keys(flow.waitJson).toSorted().join(", ") || "object";
}
function summarizeFlowState(flow) {
	if (flow.status === "blocked") {
		if (flow.blockedSummary) return flow.blockedSummary;
		if (flow.blockedTaskId) return `blocked by ${flow.blockedTaskId}`;
		return "blocked";
	}
	if (flow.status === "waiting" && flow.waitJson != null) return summarizeWait(flow);
	return null;
}
async function flowsListCommand(opts, runtime) {
	const statusFilter = opts.status?.trim();
	const flows = listTaskFlowRecords().filter((flow) => {
		if (statusFilter && flow.status !== statusFilter) return false;
		return true;
	});
	if (opts.json) {
		runtime.log(JSON.stringify({
			count: flows.length,
			status: statusFilter ?? null,
			flows: flows.map((flow) => ({
				...flow,
				tasks: listTasksForFlowId(flow.flowId),
				taskSummary: getFlowTaskSummary(flow.flowId)
			}))
		}, null, 2));
		return;
	}
	runtime.log(info(`TaskFlows: ${flows.length}`));
	runtime.log(info(`TaskFlow pressure: ${formatFlowListSummary(flows)}`));
	if (statusFilter) runtime.log(info(`Status filter: ${statusFilter}`));
	if (flows.length === 0) {
		runtime.log(`No TaskFlows found. Run ${formatCliCommand("openclaw tasks list")} to inspect standalone background tasks.`);
		return;
	}
	const rich = isRich();
	for (const line of formatFlowRows(flows, rich)) runtime.log(line);
}
async function flowsShowCommand(opts, runtime) {
	const flow = resolveTaskFlowForLookupToken(opts.lookup);
	if (!flow) {
		runtime.error(formatFlowLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	const tasks = listTasksForFlowId(flow.flowId);
	const taskSummary = getFlowTaskSummary(flow.flowId);
	const stateSummary = summarizeFlowState(flow);
	if (opts.json) {
		runtime.log(JSON.stringify({
			...flow,
			tasks,
			taskSummary
		}, null, 2));
		return;
	}
	const lines = [
		"TaskFlow:",
		`flowId: ${flow.flowId}`,
		`status: ${flow.status}`,
		`goal: ${safeFlowDisplayText(flow.goal)}`,
		`currentStep: ${safeFlowDisplayText(flow.currentStep)}`,
		`owner: ${safeFlowDisplayText(flow.ownerKey)}`,
		`notify: ${flow.notifyPolicy}`,
		...stateSummary ? [`state: ${safeFlowDisplayText(stateSummary)}`] : [],
		...flow.cancelRequestedAt ? [`cancelRequestedAt: ${new Date(flow.cancelRequestedAt).toISOString()}`] : [],
		`createdAt: ${new Date(flow.createdAt).toISOString()}`,
		`updatedAt: ${new Date(flow.updatedAt).toISOString()}`,
		`endedAt: ${flow.endedAt ? new Date(flow.endedAt).toISOString() : "n/a"}`,
		`tasks: ${taskSummary.total} total · ${taskSummary.active} active · ${taskSummary.failures} issues`
	];
	for (const line of lines) runtime.log(line);
	if (tasks.length === 0) {
		runtime.log("Linked tasks: none");
		return;
	}
	runtime.log("Linked tasks:");
	for (const task of tasks) {
		const safeLabel = safeFlowDisplayText(task.label ?? task.task);
		runtime.log(`- ${task.taskId} ${task.status} ${task.runId ?? "n/a"} ${safeLabel}`);
	}
}
async function flowsCancelCommand(opts, runtime) {
	const flow = resolveTaskFlowForLookupToken(opts.lookup);
	if (!flow) {
		runtime.error(formatFlowLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	const result = await cancelFlowById({
		cfg: getRuntimeConfig(),
		flowId: flow.flowId
	});
	if (!result.found) {
		runtime.error(result.reason ?? formatFlowLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	if (!result.cancelled) {
		runtime.error(result.reason ?? `Could not cancel TaskFlow: ${opts.lookup}`);
		runtime.exit(1);
		return;
	}
	const updated = getTaskFlowById(flow.flowId) ?? result.flow ?? flow;
	runtime.log(`Cancelled ${updated.flowId} (${updated.syncMode}) with status ${updated.status}.`);
}
//#endregion
export { flowsCancelCommand, flowsListCommand, flowsShowCommand };
