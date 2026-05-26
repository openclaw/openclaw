import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as isRich, r as theme } from "./theme-D58JpUfy.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { i as formatLookupMiss } from "./error-format-BfFDdqsq.js";
import { C as pruneStaleEntries, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { i as resolveAllAgentSessionStoreTargetsSync } from "./targets-B5o7Ubgb.js";
import "./sessions-CQHHcgC_.js";
import { A as deleteTaskFlowRecordById, D as updateTaskNotifyPolicyById, H as updateFlowRecordByIdExpectedRevision, I as listTaskFlowRecords, P as getTaskFlowById, m as listTasksForFlowId, s as getTaskById } from "./task-registry-B9ljq8Nk.js";
import { n as summarizeTaskRecords } from "./task-registry.summary-BwpoHlXv.js";
import "./runtime-internal-2F71tA3B.js";
import { t as cancelDetachedTaskRunById } from "./task-executor-BGVJzIov.js";
import { n as loadCronStoreSync, r as resolveCronStorePath } from "./store-PoorarMW.js";
import { n as listTaskAuditFindings, r as summarizeTaskAuditFindings } from "./task-registry.audit-DBGEzaF4.js";
import { c as reconcileInspectableTasks, f as runTaskRegistryMaintenance, i as getInspectableTaskRegistrySummary, l as reconcileTaskLookupToken, o as getTaskRegistryMaintenanceDiagnostics, r as getInspectableTaskAuditSummary, s as previewTaskRegistryMaintenance, t as configureTaskRegistryMaintenance } from "./task-registry.maintenance-BGxQNDMF.js";
import { n as listTaskFlowAuditFindings, r as summarizeTaskFlowAuditFindings, t as buildTaskSystemAuditFindings } from "./tasks-audit-system-B5TwkIlk.js";
import fs from "node:fs";
//#region src/tasks/task-flow-registry.maintenance.ts
const TASK_FLOW_RETENTION_MS = 10080 * 6e4;
function isTerminalFlow(flow) {
	return flow.status === "succeeded" || flow.status === "blocked" || flow.status === "failed" || flow.status === "cancelled" || flow.status === "lost";
}
function hasActiveLinkedTasks(flowId) {
	return listTasksForFlowId(flowId).some((task) => task.status === "queued" || task.status === "running");
}
function resolveTerminalAt(flow) {
	return flow.endedAt ?? flow.updatedAt ?? flow.createdAt;
}
function shouldPruneFlow(flow, now) {
	if (!isTerminalFlow(flow)) return false;
	if (hasActiveLinkedTasks(flow.flowId)) return false;
	return now - resolveTerminalAt(flow) >= TASK_FLOW_RETENTION_MS;
}
function shouldFinalizeCancelledFlow(flow) {
	if (flow.syncMode !== "managed") return false;
	if (flow.cancelRequestedAt == null || isTerminalFlow(flow)) return false;
	return !hasActiveLinkedTasks(flow.flowId);
}
function finalizeCancelledFlow(flow, now) {
	let current = flow;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const endedAt = Math.max(now, current.updatedAt, current.cancelRequestedAt ?? now);
		const result = updateFlowRecordByIdExpectedRevision({
			flowId: current.flowId,
			expectedRevision: current.revision,
			patch: {
				status: "cancelled",
				blockedTaskId: null,
				blockedSummary: null,
				waitJson: null,
				endedAt,
				updatedAt: endedAt
			}
		});
		if (result.applied) return true;
		if (result.reason === "not_found" || !result.current) return false;
		current = result.current;
		if (!shouldFinalizeCancelledFlow(current)) return false;
	}
	return false;
}
function shouldRepairTerminalMirroredFlowTimestamp(flow) {
	if (flow.syncMode !== "task_mirrored" || !isTerminalFlow(flow)) return false;
	if (flow.endedAt == null || flow.endedAt < flow.createdAt) return false;
	return flow.updatedAt > flow.endedAt;
}
function repairTerminalMirroredFlowTimestamp(flow) {
	let current = flow;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (!shouldRepairTerminalMirroredFlowTimestamp(current)) return false;
		const result = updateFlowRecordByIdExpectedRevision({
			flowId: current.flowId,
			expectedRevision: current.revision,
			patch: { updatedAt: current.endedAt }
		});
		if (result.applied) return true;
		if (result.reason === "not_found" || !result.current) return false;
		current = result.current;
	}
	return false;
}
function getInspectableTaskFlowAuditSummary() {
	return summarizeTaskFlowAuditFindings(listTaskFlowAuditFindings());
}
function previewTaskFlowRegistryMaintenance() {
	const now = Date.now();
	let reconciled = 0;
	let pruned = 0;
	for (const flow of listTaskFlowRecords()) {
		if (shouldRepairTerminalMirroredFlowTimestamp(flow)) {
			reconciled += 1;
			continue;
		}
		if (shouldFinalizeCancelledFlow(flow)) {
			reconciled += 1;
			continue;
		}
		if (shouldPruneFlow(flow, now)) pruned += 1;
	}
	return {
		reconciled,
		pruned
	};
}
async function runTaskFlowRegistryMaintenance() {
	const now = Date.now();
	let reconciled = 0;
	let pruned = 0;
	for (const flow of listTaskFlowRecords()) {
		const current = getTaskFlowById(flow.flowId);
		if (!current) continue;
		if (shouldRepairTerminalMirroredFlowTimestamp(current)) {
			if (repairTerminalMirroredFlowTimestamp(current)) reconciled += 1;
			continue;
		}
		if (shouldFinalizeCancelledFlow(current)) {
			if (finalizeCancelledFlow(current, now)) reconciled += 1;
			continue;
		}
		if (shouldPruneFlow(current, now) && deleteTaskFlowRecordById(current.flowId)) pruned += 1;
	}
	return {
		reconciled,
		pruned
	};
}
//#endregion
//#region src/commands/tasks.ts
const RUNTIME_PAD = 8;
const STATUS_PAD = 10;
const DELIVERY_PAD = 14;
const ID_PAD = 10;
const RUN_PAD = 10;
const SESSION_REGISTRY_RETENTION_MS = 10080 * 6e4;
const info = theme.info;
function formatTaskLookupMiss(lookup) {
	return formatLookupMiss({
		noun: "Task",
		value: lookup,
		listCommand: "openclaw tasks list",
		valueLabel: "task id"
	});
}
async function loadTaskCancelConfig() {
	return getRuntimeConfig();
}
function configureTaskMaintenanceFromConfig() {
	configureTaskRegistryMaintenance({ cronStorePath: resolveCronStorePath(getRuntimeConfig().cron?.store) });
}
function parseCronRunSessionJobId(sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return;
	return /^cron:([^:]+):run:[^:]+$/u.exec(parsed.rest)?.[1];
}
function readRunningCronJobIds() {
	try {
		const cronStorePath = resolveCronStorePath(getRuntimeConfig().cron?.store);
		return new Set(loadCronStoreSync(cronStorePath).jobs.filter((job) => typeof job.state?.runningAtMs === "number").map((job) => job.id.toLowerCase()));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
function buildSessionRegistryPreserveKeys(params) {
	const preserveKeys = /* @__PURE__ */ new Set();
	let preservedRunning = 0;
	for (const key of Object.keys(params.store)) {
		const jobId = parseCronRunSessionJobId(key);
		if (!jobId) {
			preserveKeys.add(key);
			continue;
		}
		if (params.runningCronJobIds.has(jobId)) {
			preserveKeys.add(key);
			preservedRunning += 1;
		}
	}
	return {
		preserveKeys,
		preservedRunning
	};
}
async function runSessionRegistryMaintenance(params) {
	const cfg = getRuntimeConfig();
	const runningCronJobIds = readRunningCronJobIds();
	const stores = [];
	for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
		if (!fs.existsSync(target.storePath)) {
			stores.push({
				agentId: target.agentId,
				storePath: target.storePath,
				beforeCount: 0,
				afterCount: 0,
				pruned: 0,
				preservedRunning: 0
			});
			continue;
		}
		const beforeStore = loadSessionStore(target.storePath, { skipCache: true });
		const beforeCount = Object.keys(beforeStore).length;
		if (params.apply) {
			const applied = await updateSessionStore(target.storePath, (store) => {
				const { preserveKeys, preservedRunning } = buildSessionRegistryPreserveKeys({
					store,
					runningCronJobIds
				});
				return {
					pruned: pruneStaleEntries(store, SESSION_REGISTRY_RETENTION_MS, {
						log: false,
						preserveKeys
					}),
					afterCount: Object.keys(store).length,
					preservedRunning
				};
			}, { skipMaintenance: true });
			stores.push({
				agentId: target.agentId,
				storePath: target.storePath,
				beforeCount,
				afterCount: applied.afterCount,
				pruned: applied.pruned,
				preservedRunning: applied.preservedRunning
			});
			continue;
		}
		const previewStore = structuredClone(beforeStore);
		const { preserveKeys, preservedRunning } = buildSessionRegistryPreserveKeys({
			store: previewStore,
			runningCronJobIds
		});
		const pruned = pruneStaleEntries(previewStore, SESSION_REGISTRY_RETENTION_MS, {
			log: false,
			preserveKeys
		});
		stores.push({
			agentId: target.agentId,
			storePath: target.storePath,
			beforeCount,
			afterCount: Object.keys(previewStore).length,
			pruned,
			preservedRunning
		});
	}
	return {
		retentionMs: SESSION_REGISTRY_RETENTION_MS,
		runningCronJobs: runningCronJobIds.size,
		pruned: stores.reduce((total, store) => total + store.pruned, 0),
		stores
	};
}
function truncate(value, maxChars) {
	if (value.length <= maxChars) return value;
	if (maxChars <= 1) return value.slice(0, maxChars);
	return `${value.slice(0, maxChars - 1)}…`;
}
function shortToken(value, maxChars = ID_PAD) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return "n/a";
	return truncate(trimmed, maxChars);
}
function formatTaskStatusCell(status, rich) {
	const padded = status.padEnd(STATUS_PAD);
	if (!rich) return padded;
	if (status === "succeeded") return theme.success(padded);
	if (status === "failed" || status === "lost" || status === "timed_out") return theme.error(padded);
	if (status === "running") return theme.accentBright(padded);
	return theme.muted(padded);
}
function formatTaskRows(tasks, rich) {
	const header = [
		"Task".padEnd(ID_PAD),
		"Kind".padEnd(RUNTIME_PAD),
		"Status".padEnd(STATUS_PAD),
		"Delivery".padEnd(DELIVERY_PAD),
		"Run".padEnd(RUN_PAD),
		"Child Session",
		"Summary"
	].join(" ");
	const lines = [rich ? theme.heading(header) : header];
	for (const task of tasks) {
		const summary = truncate(normalizeOptionalString(task.terminalSummary) || normalizeOptionalString(task.progressSummary) || normalizeOptionalString(task.label) || task.task.trim(), 80);
		const line = [
			shortToken(task.taskId).padEnd(ID_PAD),
			task.runtime.padEnd(RUNTIME_PAD),
			formatTaskStatusCell(task.status, rich),
			task.deliveryStatus.padEnd(DELIVERY_PAD),
			shortToken(task.runId, RUN_PAD).padEnd(RUN_PAD),
			truncate(normalizeOptionalString(task.childSessionKey) || "n/a", 36).padEnd(36),
			summary
		].join(" ");
		lines.push(line.trimEnd());
	}
	return lines;
}
function formatTaskListSummary(tasks) {
	const summary = summarizeTaskRecords(tasks);
	return `${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${summary.failures} issues`;
}
function formatAgeMs(ageMs) {
	if (typeof ageMs !== "number" || ageMs < 1e3) return "fresh";
	const totalSeconds = Math.floor(ageMs / 1e3);
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor(totalSeconds % 86400 / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${totalSeconds}s`;
}
function formatAuditRows(findings, rich) {
	const header = [
		"Scope".padEnd(8),
		"Severity".padEnd(8),
		"Code".padEnd(22),
		"Item".padEnd(ID_PAD),
		"Status".padEnd(STATUS_PAD),
		"Age".padEnd(8),
		"Detail"
	].join(" ");
	const lines = [rich ? theme.heading(header) : header];
	for (const finding of findings) {
		const severity = finding.severity.padEnd(8);
		const status = formatTaskStatusCell(finding.status ?? "n/a", rich);
		const severityCell = !rich ? severity : finding.severity === "error" ? theme.error(severity) : theme.warn(severity);
		const scope = finding.kind === "task" ? "Task" : "TaskFlow";
		lines.push([
			scope.padEnd(8),
			severityCell,
			finding.code.padEnd(22),
			shortToken(finding.token).padEnd(ID_PAD),
			status,
			formatAgeMs(finding.ageMs).padEnd(8),
			truncate(finding.detail, 88)
		].join(" ").trimEnd());
	}
	return lines;
}
function toSystemAuditFindings(params) {
	return buildTaskSystemAuditFindings({
		taskFindings: listTaskAuditFindings({ tasks: reconcileInspectableTasks() }),
		flowFindings: listTaskFlowAuditFindings(),
		severityFilter: params.severityFilter,
		codeFilter: params.codeFilter
	});
}
async function tasksListCommand(opts, runtime) {
	const runtimeFilter = opts.runtime?.trim();
	const statusFilter = opts.status?.trim();
	const tasks = reconcileInspectableTasks().filter((task) => {
		if (runtimeFilter && task.runtime !== runtimeFilter) return false;
		if (statusFilter && task.status !== statusFilter) return false;
		return true;
	});
	if (opts.json) {
		runtime.log(JSON.stringify({
			count: tasks.length,
			runtime: runtimeFilter ?? null,
			status: statusFilter ?? null,
			tasks
		}, null, 2));
		return;
	}
	runtime.log(info(`Background tasks: ${tasks.length}`));
	runtime.log(info(`Task pressure: ${formatTaskListSummary(tasks)}`));
	if (runtimeFilter) runtime.log(info(`Runtime filter: ${runtimeFilter}`));
	if (statusFilter) runtime.log(info(`Status filter: ${statusFilter}`));
	if (tasks.length === 0) {
		runtime.log(`No background tasks found. Run ${formatCliCommand("openclaw tasks audit")} to check for stale task state.`);
		return;
	}
	const rich = isRich();
	for (const line of formatTaskRows(tasks, rich)) runtime.log(line);
}
async function tasksShowCommand(opts, runtime) {
	const task = reconcileTaskLookupToken(opts.lookup);
	if (!task) {
		runtime.error(formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	if (opts.json) {
		runtime.log(JSON.stringify(task, null, 2));
		return;
	}
	const lines = [
		"Background task:",
		`taskId: ${task.taskId}`,
		`kind: ${task.runtime}`,
		`sourceId: ${task.sourceId ?? "n/a"}`,
		`status: ${task.status}`,
		`result: ${task.terminalOutcome ?? "n/a"}`,
		`delivery: ${task.deliveryStatus}`,
		`notify: ${task.notifyPolicy}`,
		`ownerKey: ${task.ownerKey}`,
		`childSessionKey: ${task.childSessionKey ?? "n/a"}`,
		`parentTaskId: ${task.parentTaskId ?? "n/a"}`,
		`agentId: ${task.agentId ?? "n/a"}`,
		`runId: ${task.runId ?? "n/a"}`,
		`label: ${task.label ?? "n/a"}`,
		`task: ${task.task}`,
		`createdAt: ${new Date(task.createdAt).toISOString()}`,
		`startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : "n/a"}`,
		`endedAt: ${task.endedAt ? new Date(task.endedAt).toISOString() : "n/a"}`,
		`lastEventAt: ${task.lastEventAt ? new Date(task.lastEventAt).toISOString() : "n/a"}`,
		`cleanupAfter: ${task.cleanupAfter ? new Date(task.cleanupAfter).toISOString() : "n/a"}`,
		...task.error ? [`error: ${task.error}`] : [],
		...task.progressSummary ? [`progressSummary: ${task.progressSummary}`] : [],
		...task.terminalSummary ? [`terminalSummary: ${task.terminalSummary}`] : []
	];
	for (const line of lines) runtime.log(line);
}
async function tasksNotifyCommand(opts, runtime) {
	const task = reconcileTaskLookupToken(opts.lookup);
	if (!task) {
		runtime.error(formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	const updated = updateTaskNotifyPolicyById({
		taskId: task.taskId,
		notifyPolicy: opts.notify
	});
	if (!updated) {
		runtime.error(formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	runtime.log(`Updated ${updated.taskId} notify policy to ${updated.notifyPolicy}.`);
}
async function tasksCancelCommand(opts, runtime) {
	const task = reconcileTaskLookupToken(opts.lookup);
	if (!task) {
		runtime.error(formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	const result = await cancelDetachedTaskRunById({
		cfg: await loadTaskCancelConfig(),
		taskId: task.taskId
	});
	if (!result.found) {
		runtime.error(result.reason ?? formatTaskLookupMiss(opts.lookup));
		runtime.exit(1);
		return;
	}
	if (!result.cancelled) {
		runtime.error(result.reason ?? `Could not cancel task: ${opts.lookup}`);
		runtime.exit(1);
		return;
	}
	const updated = getTaskById(task.taskId);
	runtime.log(`Cancelled ${updated?.taskId ?? task.taskId} (${updated?.runtime ?? task.runtime})${updated?.runId ? ` run ${updated.runId}` : ""}.`);
}
async function tasksAuditCommand(opts, runtime) {
	configureTaskMaintenanceFromConfig();
	const severityFilter = opts.severity?.trim();
	const codeFilter = opts.code?.trim();
	const { allFindings, filteredFindings, taskFindings, summary } = toSystemAuditFindings({
		severityFilter,
		codeFilter
	});
	const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : void 0;
	const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;
	if (opts.json) {
		const legacySummary = summarizeTaskAuditFindings(taskFindings);
		runtime.log(JSON.stringify({
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
		}, null, 2));
		return;
	}
	runtime.log(info(`Tasks audit: ${summary.total} findings · ${summary.errors} errors · ${summary.warnings} warnings`));
	if (severityFilter || codeFilter) runtime.log(info(`Showing ${filteredFindings.length} matching findings.`));
	if (severityFilter) runtime.log(info(`Severity filter: ${severityFilter}`));
	if (codeFilter) runtime.log(info(`Code filter: ${codeFilter}`));
	if (limit) runtime.log(info(`Limit: ${limit}`));
	runtime.log(info(`Task findings: ${summary.tasks.total} · TaskFlow findings: ${summary.taskFlows.total}`));
	if (displayed.length === 0) {
		runtime.log("No tasks audit findings.");
		return;
	}
	const rich = isRich();
	for (const line of formatAuditRows(displayed, rich)) runtime.log(line);
}
async function tasksMaintenanceCommand(opts, runtime) {
	configureTaskMaintenanceFromConfig();
	const auditBefore = getInspectableTaskAuditSummary();
	const flowAuditBefore = getInspectableTaskFlowAuditSummary();
	const taskMaintenance = opts.apply ? await runTaskRegistryMaintenance() : previewTaskRegistryMaintenance();
	const diagnostics = opts.json ? getTaskRegistryMaintenanceDiagnostics() : void 0;
	const flowMaintenance = opts.apply ? await runTaskFlowRegistryMaintenance() : previewTaskFlowRegistryMaintenance();
	const sessionMaintenance = await runSessionRegistryMaintenance({ apply: Boolean(opts.apply) });
	const summary = getInspectableTaskRegistrySummary();
	const auditAfter = opts.apply ? getInspectableTaskAuditSummary() : auditBefore;
	const flowAuditAfter = opts.apply ? getInspectableTaskFlowAuditSummary() : flowAuditBefore;
	if (opts.json) {
		runtime.log(JSON.stringify({
			mode: opts.apply ? "apply" : "preview",
			maintenance: {
				tasks: taskMaintenance,
				taskFlows: flowMaintenance,
				sessions: sessionMaintenance
			},
			tasks: summary,
			diagnostics,
			auditBefore: {
				...auditBefore,
				taskFlows: flowAuditBefore
			},
			auditAfter: {
				...auditAfter,
				taskFlows: flowAuditAfter
			}
		}, null, 2));
		return;
	}
	runtime.log(info(`Tasks maintenance (${opts.apply ? "applied" : "preview"}): tasks ${taskMaintenance.reconciled} reconcile · ${taskMaintenance.recovered} recovered · ${taskMaintenance.cleanupStamped} cleanup stamp · ${taskMaintenance.pruned} prune; task-flows ${flowMaintenance.reconciled} reconcile · ${flowMaintenance.pruned} prune`));
	runtime.log(info(`Session registry: ${sessionMaintenance.pruned} prune · ${sessionMaintenance.runningCronJobs} running cron jobs`));
	runtime.log(info(`${opts.apply ? "Tasks health after apply" : "Tasks health"}: ${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${auditAfter.errors + flowAuditAfter.errors} audit errors · ${auditAfter.warnings + flowAuditAfter.warnings} audit warnings`));
	if (opts.apply) runtime.log(info(`Tasks health before apply: ${auditBefore.errors + flowAuditBefore.errors} audit errors · ${auditBefore.warnings + flowAuditBefore.warnings} audit warnings`));
	if (!opts.apply) runtime.log("Dry run only. Re-run with `openclaw tasks maintenance --apply` to write changes.");
}
//#endregion
export { tasksAuditCommand, tasksCancelCommand, tasksListCommand, tasksMaintenanceCommand, tasksNotifyCommand, tasksShowCommand };
