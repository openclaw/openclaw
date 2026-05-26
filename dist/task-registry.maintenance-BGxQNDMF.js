import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as sweepExpiredPluginStateEntries, r as isPluginStateDatabaseOpen } from "./plugin-state-store-BqBrqTkQ.js";
import { c as getAgentRunContext } from "./agent-events-BuYtWSh4.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import "./sessions-CQHHcgC_.js";
import { t as deriveSessionChatTypeFromKey } from "./session-chat-type-shared-DwI649ZK.js";
import { G as CODEX_NATIVE_SUBAGENT_STALE_ERROR, T as setTaskCleanupAfterById, b as markTaskTerminalById, c as hasActiveTaskForChildSessionKey, f as listTaskRecords, i as ensureTaskRegistryReady, q as isChildlessCodexNativeSubagentTask, r as deleteTaskRecordById, s as getTaskById, v as markTaskLostById, w as resolveTaskForLookupToken, x as maybeDeliverTaskTerminalUpdate } from "./task-registry-B9ljq8Nk.js";
import { n as summarizeTaskRecords } from "./task-registry.summary-BwpoHlXv.js";
import "./runtime-internal-2F71tA3B.js";
import { d as tryRecoverTaskBeforeMarkLost, s as getDetachedTaskLifecycleRuntime } from "./detached-task-runtime-C79km_82.js";
import { t as getAcpSessionManager } from "./manager-CnO_4PJM.js";
import { n as readAcpSessionEntry, t as listAcpSessionEntries } from "./session-meta-CZ8B2a4Z.js";
import { i as isSubagentRecoveryWedgedEntry, r as formatSubagentRecoveryWedgedReason } from "./subagent-recovery-state-Chw_zLIZ.js";
import { r as isCronJobActive } from "./active-jobs-D4eKAY4b.js";
import { a as resolveCronRunLogPath, i as readCronRunLogEntriesSync } from "./run-log-Bi9tKROY.js";
import { n as loadCronStoreSync, r as resolveCronStorePath } from "./store-PoorarMW.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { n as listTaskAuditFindings, r as summarizeTaskAuditFindings, t as configureTaskAuditTaskProvider } from "./task-registry.audit-DBGEzaF4.js";
//#region src/tasks/task-registry.maintenance.ts
const log = createSubsystemLogger("tasks/task-registry-maintenance");
const TASK_RECONCILE_GRACE_MS = 5 * 6e4;
const CHILDLESS_CODEX_NATIVE_RECONCILE_GRACE_MS = 30 * 6e4;
const TASK_STALE_RUNNING_MS = 30 * 6e4;
const TASK_RETENTION_MS = 10080 * 6e4;
const TASK_SWEEP_INTERVAL_MS = 6e4;
/**
* Number of tasks to process before yielding to the event loop.
* Keeps the main thread responsive during large sweeps.
*/
const SWEEP_YIELD_BATCH_SIZE = 25;
let sweeper = null;
let deferredSweep = null;
let sweepInProgress = false;
let configuredCronStorePath;
let configuredCronRuntimeAuthoritative = false;
const defaultTaskRegistryMaintenanceRuntime = {
	listAcpSessionEntries,
	readAcpSessionEntry,
	closeAcpSession: async ({ cfg, sessionKey, reason }) => {
		await getAcpSessionManager().closeSession({
			cfg,
			sessionKey,
			reason,
			discardPersistentState: true,
			clearMeta: true,
			allowBackendUnavailable: true,
			requireAcpSession: false
		});
	},
	listSessionBindingsBySession: (sessionKey) => getSessionBindingService().listBySession(sessionKey),
	unbindSessionBindings: (input) => getSessionBindingService().unbind(input),
	loadSessionStore,
	resolveStorePath,
	deriveSessionChatTypeFromKey,
	isCronJobActive,
	getAgentRunContext,
	parseAgentSessionKey,
	hasActiveTaskForChildSessionKey,
	deleteTaskRecordById,
	ensureTaskRegistryReady,
	getTaskById,
	listTaskRecords,
	markTaskLostById,
	markTaskTerminalById,
	maybeDeliverTaskTerminalUpdate,
	resolveTaskForLookupToken,
	setTaskCleanupAfterById,
	isCronRuntimeAuthoritative: () => configuredCronRuntimeAuthoritative,
	resolveCronStorePath: () => configuredCronStorePath ?? resolveCronStorePath(),
	loadCronStoreSync,
	resolveCronRunLogPath,
	readCronRunLogEntriesSync
};
let taskRegistryMaintenanceRuntime = defaultTaskRegistryMaintenanceRuntime;
function createCronRecoveryContext() {
	return {
		storePath: taskRegistryMaintenanceRuntime.resolveCronStorePath(),
		runLogsByJobId: /* @__PURE__ */ new Map()
	};
}
function createBackingSessionLookupContext() {
	return {
		sessionStoresByPath: /* @__PURE__ */ new Map(),
		sessionChatTypesByKey: /* @__PURE__ */ new Map()
	};
}
function getSessionStoreLookup(storePath, context) {
	if (!context) return { store: taskRegistryMaintenanceRuntime.loadSessionStore(storePath, { clone: false }) };
	const cached = context.sessionStoresByPath.get(storePath);
	if (cached) return cached;
	const lookup = { store: taskRegistryMaintenanceRuntime.loadSessionStore(storePath, { clone: false }) };
	context.sessionStoresByPath.set(storePath, lookup);
	return lookup;
}
function getNormalizedSessionEntries(lookup) {
	if (lookup.normalizedEntries) return lookup.normalizedEntries;
	const entries = /* @__PURE__ */ new Map();
	for (const [key, entry] of Object.entries(lookup.store)) if (entry) entries.set(normalizeLowercaseStringOrEmpty(key), entry);
	lookup.normalizedEntries = entries;
	return entries;
}
function findSessionEntryByKey(lookup, sessionKey) {
	const direct = lookup.store[sessionKey];
	if (direct) return direct;
	const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
	if (!normalized) return;
	return getNormalizedSessionEntries(lookup).get(normalized);
}
function resolveSessionChatType(sessionKey, context) {
	const derive = taskRegistryMaintenanceRuntime.deriveSessionChatTypeFromKey ?? deriveSessionChatTypeFromKey;
	if (!context) return derive(sessionKey);
	const cached = context.sessionChatTypesByKey.get(sessionKey);
	if (cached) return cached;
	const chatType = derive(sessionKey);
	context.sessionChatTypesByKey.set(sessionKey, chatType);
	return chatType;
}
function findTaskSessionEntry(task, context) {
	const childSessionKey = task.childSessionKey?.trim();
	if (!childSessionKey) return;
	const agentId = taskRegistryMaintenanceRuntime.parseAgentSessionKey(childSessionKey)?.agentId;
	return findSessionEntryByKey(getSessionStoreLookup(taskRegistryMaintenanceRuntime.resolveStorePath(void 0, { agentId }), context), childSessionKey);
}
function isActiveTask(task) {
	return task.status === "queued" || task.status === "running";
}
function isTerminalTask(task) {
	return !isActiveTask(task);
}
function hasLostGraceExpired(task, now) {
	const referenceAt = task.lastEventAt ?? task.startedAt ?? task.createdAt;
	const graceMs = isChildlessCodexNativeSubagentTask(task) ? CHILDLESS_CODEX_NATIVE_RECONCILE_GRACE_MS : TASK_RECONCILE_GRACE_MS;
	return now - referenceAt >= graceMs;
}
function parseCronExecutionId(task) {
	const runId = task.runId?.trim();
	if (!runId?.startsWith("cron:")) return;
	const separator = runId.lastIndexOf(":");
	if (separator <= 5) return;
	const startedAt = Number(runId.slice(separator + 1));
	if (!Number.isFinite(startedAt)) return;
	const jobId = runId.slice(5, separator).trim();
	if (!jobId || task.sourceId?.trim() && task.sourceId.trim() !== jobId) return;
	return {
		jobId,
		startedAt
	};
}
function isTimeoutCronError(error) {
	return error === "cron: job execution timed out";
}
function mapCronTerminalStatus(status, error) {
	if (status === "ok" || status === "skipped") return "succeeded";
	return isTimeoutCronError(error) ? "timed_out" : "failed";
}
function getCronRunLogEntries(context, jobId) {
	const cached = context.runLogsByJobId.get(jobId);
	if (cached) return cached;
	let entries = [];
	try {
		const logPath = taskRegistryMaintenanceRuntime.resolveCronRunLogPath({
			storePath: context.storePath,
			jobId
		});
		entries = taskRegistryMaintenanceRuntime.readCronRunLogEntriesSync(logPath, {
			jobId,
			limit: 5e3
		});
	} catch {
		entries = [];
	}
	context.runLogsByJobId.set(jobId, entries);
	return entries;
}
function getCronStore(context) {
	if (context.store !== void 0) return context.store;
	try {
		context.store = taskRegistryMaintenanceRuntime.loadCronStoreSync(context.storePath);
	} catch {
		context.store = null;
	}
	return context.store;
}
function resolveCronRunLogRecovery(execution, context) {
	const entry = getCronRunLogEntries(context, execution.jobId).findLast((candidate) => candidate.jobId === execution.jobId && candidate.action === "finished" && candidate.runAtMs === execution.startedAt && (candidate.status === "ok" || candidate.status === "skipped" || candidate.status === "error"));
	if (!entry) return;
	const durationMs = typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) ? Math.max(0, entry.durationMs) : void 0;
	const endedAt = durationMs === void 0 ? entry.ts : execution.startedAt + durationMs;
	return {
		status: mapCronTerminalStatus(entry.status, entry.error),
		endedAt,
		lastEventAt: endedAt,
		...entry.error !== void 0 ? { error: entry.error } : {},
		...entry.summary !== void 0 ? { terminalSummary: entry.summary } : {}
	};
}
function resolveCronJobStateRecovery(execution, context) {
	const job = getCronStore(context)?.jobs.find((entry) => entry.id === execution.jobId);
	if (!job || job.state.lastRunAtMs !== execution.startedAt) return;
	const status = job.state.lastRunStatus ?? job.state.lastStatus;
	if (status !== "ok" && status !== "skipped" && status !== "error") return;
	const durationMs = typeof job.state.lastDurationMs === "number" && Number.isFinite(job.state.lastDurationMs) ? Math.max(0, job.state.lastDurationMs) : 0;
	const endedAt = execution.startedAt + durationMs;
	return {
		status: mapCronTerminalStatus(status, job.state.lastError),
		endedAt,
		lastEventAt: endedAt,
		...job.state.lastError !== void 0 ? { error: job.state.lastError } : {}
	};
}
function resolveDurableCronTaskRecovery(task, context) {
	if (task.runtime !== "cron" || !isActiveTask(task)) return;
	const execution = parseCronExecutionId(task);
	if (!execution) return;
	return resolveCronRunLogRecovery(execution, context) ?? resolveCronJobStateRecovery(execution, context);
}
function hasActiveCliRun(task) {
	const candidateRunIds = [task.sourceId, task.runId];
	for (const candidate of candidateRunIds) {
		const runId = candidate?.trim();
		if (runId && taskRegistryMaintenanceRuntime.getAgentRunContext(runId)) return true;
	}
	return false;
}
function hasCliRunIdentity(task) {
	return [task.sourceId, task.runId].some((candidate) => Boolean(candidate?.trim()));
}
function hasBackingSession(task, context) {
	if (task.runtime === "cron") {
		if (!taskRegistryMaintenanceRuntime.isCronRuntimeAuthoritative()) return true;
		const jobId = task.sourceId?.trim();
		return jobId ? taskRegistryMaintenanceRuntime.isCronJobActive(jobId) : false;
	}
	if (task.runtime === "cli" && hasActiveCliRun(task)) return true;
	if (task.runtime === "cli" && hasCliRunIdentity(task)) return false;
	const childSessionKey = task.childSessionKey?.trim();
	if (!childSessionKey) return !isChildlessCodexNativeSubagentTask(task);
	if (task.runtime === "acp") {
		const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({ sessionKey: childSessionKey });
		if (!acpEntry || acpEntry.storeReadFailed) return true;
		return Boolean(acpEntry.entry);
	}
	if (task.runtime === "subagent" || task.runtime === "cli") {
		if (task.runtime === "cli") {
			const chatType = resolveSessionChatType(childSessionKey, context);
			if (chatType === "channel" || chatType === "group" || chatType === "direct") return false;
		}
		const entry = findTaskSessionEntry(task, context);
		if (task.runtime === "subagent" && isSubagentRecoveryWedgedEntry(entry)) return false;
		return Boolean(entry);
	}
	return true;
}
function resolveTaskLostError(task, context) {
	if (isChildlessCodexNativeSubagentTask(task)) return CODEX_NATIVE_SUBAGENT_STALE_ERROR;
	if (task.runtime === "subagent") {
		const entry = findTaskSessionEntry(task, context);
		if (entry && isSubagentRecoveryWedgedEntry(entry)) return formatSubagentRecoveryWedgedReason(entry);
	}
	return "backing session missing";
}
function shouldMarkLost(task, now, context) {
	if (!isActiveTask(task)) return false;
	if (!hasLostGraceExpired(task, now)) return false;
	return !hasBackingSession(task, context);
}
function hasTaskLostDecisionInputChanged(before, after) {
	return before.status !== after.status || before.runtime !== after.runtime || before.childSessionKey !== after.childSessionKey || before.sourceId !== after.sourceId || before.runId !== after.runId || before.createdAt !== after.createdAt || before.startedAt !== after.startedAt || before.lastEventAt !== after.lastEventAt;
}
function hasDetachedTaskRecoveryHook() {
	return Boolean(getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost);
}
function shouldPruneTerminalTask(task, now) {
	if (!isTerminalTask(task)) return false;
	if (typeof task.cleanupAfter === "number") return now >= task.cleanupAfter;
	return now - (task.endedAt ?? task.lastEventAt ?? task.createdAt) >= TASK_RETENTION_MS;
}
function shouldStampCleanupAfter(task) {
	return isTerminalTask(task) && typeof task.cleanupAfter !== "number";
}
function resolveCleanupAfter(task) {
	return (task.endedAt ?? task.lastEventAt ?? task.createdAt) + TASK_RETENTION_MS;
}
function taskReferenceAt(task) {
	return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}
function getNormalizedTaskChildSessionKey(task) {
	return normalizeOptionalString(task.childSessionKey);
}
function getAcpSessionParentKeys(acpEntry) {
	return [normalizeOptionalString(acpEntry.entry?.spawnedBy), normalizeOptionalString(acpEntry.entry?.parentSessionKey)].filter((value) => Boolean(value));
}
function isParentOwnedAcpSessionTask(task, acpEntry) {
	const entry = acpEntry?.entry;
	if (!entry) return false;
	const ownerKey = normalizeOptionalString(task.ownerKey);
	const requesterKey = normalizeOptionalString(task.requesterSessionKey);
	return getAcpSessionParentKeys({ entry }).some((parentKey) => parentKey === ownerKey || parentKey === requesterKey);
}
function isParentOwnedAcpSessionEntry(acpEntry) {
	return getAcpSessionParentKeys(acpEntry).length > 0;
}
function hasActiveSessionBinding(sessionKey) {
	const listBindings = taskRegistryMaintenanceRuntime.listSessionBindingsBySession;
	if (!listBindings) return true;
	try {
		return listBindings(sessionKey).some((binding) => binding.status !== "ended");
	} catch {
		return true;
	}
}
function shouldCloseTerminalAcpSession(task) {
	if (task.runtime !== "acp" || isActiveTask(task)) return false;
	const sessionKey = getNormalizedTaskChildSessionKey(task);
	if (!sessionKey || taskRegistryMaintenanceRuntime.hasActiveTaskForChildSessionKey({
		sessionKey,
		excludeTaskId: task.taskId
	})) return false;
	const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({ sessionKey });
	if (!acpEntry || acpEntry.storeReadFailed || !acpEntry.acp) return false;
	if (!isParentOwnedAcpSessionTask(task, acpEntry)) return false;
	if (acpEntry.acp.mode === "oneshot") return true;
	return !hasActiveSessionBinding(sessionKey);
}
function shouldCloseOrphanedParentOwnedAcpSession(acpEntry) {
	if (!acpEntry.entry || !acpEntry.acp || !isParentOwnedAcpSessionEntry(acpEntry)) return false;
	const sessionKey = normalizeOptionalString(acpEntry.sessionKey);
	if (!sessionKey || taskRegistryMaintenanceRuntime.hasActiveTaskForChildSessionKey({ sessionKey })) return false;
	if (acpEntry.acp.mode === "oneshot") return true;
	return !hasActiveSessionBinding(sessionKey);
}
async function cleanupTerminalAcpSession(task) {
	if (!shouldCloseTerminalAcpSession(task)) return;
	const sessionKey = getNormalizedTaskChildSessionKey(task);
	if (!sessionKey) return;
	const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({ sessionKey });
	const closeAcpSession = taskRegistryMaintenanceRuntime.closeAcpSession;
	if (!acpEntry || !closeAcpSession) return;
	try {
		await closeAcpSession({
			cfg: acpEntry.cfg,
			sessionKey,
			reason: "terminal-task-cleanup"
		});
	} catch (error) {
		log.warn("Failed to close terminal ACP session during task maintenance", {
			sessionKey,
			taskId: task.taskId,
			error
		});
		return;
	}
	try {
		await taskRegistryMaintenanceRuntime.unbindSessionBindings?.({
			targetSessionKey: sessionKey,
			reason: "terminal-task-cleanup"
		});
	} catch (error) {
		log.warn("Failed to unbind terminal ACP session during task maintenance", {
			sessionKey,
			taskId: task.taskId,
			error
		});
	}
}
async function cleanupOrphanedParentOwnedAcpSessions() {
	let acpSessions;
	try {
		acpSessions = await taskRegistryMaintenanceRuntime.listAcpSessionEntries({});
	} catch (error) {
		log.warn("Failed to list ACP sessions during task maintenance", { error });
		return;
	}
	const seenSessionKeys = /* @__PURE__ */ new Set();
	for (const acpEntry of acpSessions) {
		const sessionKey = normalizeOptionalString(acpEntry.sessionKey);
		if (!sessionKey || seenSessionKeys.has(sessionKey)) continue;
		seenSessionKeys.add(sessionKey);
		if (!shouldCloseOrphanedParentOwnedAcpSession(acpEntry)) continue;
		const closeAcpSession = taskRegistryMaintenanceRuntime.closeAcpSession;
		if (!closeAcpSession) continue;
		try {
			await closeAcpSession({
				cfg: acpEntry.cfg,
				sessionKey,
				reason: "orphaned-parent-task-cleanup"
			});
		} catch (error) {
			log.warn("Failed to close orphaned parent-owned ACP session during task maintenance", {
				sessionKey,
				error
			});
			continue;
		}
		try {
			await taskRegistryMaintenanceRuntime.unbindSessionBindings?.({
				targetSessionKey: sessionKey,
				reason: "orphaned-parent-task-cleanup"
			});
		} catch (error) {
			log.warn("Failed to unbind orphaned parent-owned ACP session during task maintenance", {
				sessionKey,
				error
			});
		}
	}
}
function markTaskLost(task, now, context) {
	const cleanupAfter = task.cleanupAfter ?? resolveCleanupAfter({
		...task,
		endedAt: task.endedAt ?? now
	});
	const updated = taskRegistryMaintenanceRuntime.markTaskLostById({
		taskId: task.taskId,
		endedAt: task.endedAt ?? now,
		lastEventAt: now,
		error: task.error ?? resolveTaskLostError(task, context),
		cleanupAfter
	}) ?? task;
	taskRegistryMaintenanceRuntime.maybeDeliverTaskTerminalUpdate(updated.taskId);
	return updated;
}
function markTaskRecovered(task, recovery) {
	const updated = taskRegistryMaintenanceRuntime.markTaskTerminalById({
		taskId: task.taskId,
		status: recovery.status,
		endedAt: recovery.endedAt,
		lastEventAt: recovery.lastEventAt,
		...recovery.error !== void 0 ? { error: recovery.error } : {},
		...recovery.terminalSummary !== void 0 ? { terminalSummary: recovery.terminalSummary } : {}
	}) ?? projectTaskRecovered(task, recovery);
	taskRegistryMaintenanceRuntime.maybeDeliverTaskTerminalUpdate(updated.taskId);
	return updated;
}
function projectTaskRecovered(task, recovery) {
	const projected = {
		...task,
		status: recovery.status,
		endedAt: recovery.endedAt,
		lastEventAt: recovery.lastEventAt,
		...recovery.error !== void 0 ? { error: recovery.error } : {},
		...recovery.terminalSummary !== void 0 ? { terminalSummary: recovery.terminalSummary } : {}
	};
	return {
		...projected,
		...typeof projected.cleanupAfter === "number" ? {} : { cleanupAfter: resolveCleanupAfter(projected) }
	};
}
function projectTaskLost(task, now, context) {
	const projected = {
		...task,
		status: "lost",
		endedAt: task.endedAt ?? now,
		lastEventAt: now,
		error: task.error ?? resolveTaskLostError(task, context)
	};
	return {
		...projected,
		...typeof projected.cleanupAfter === "number" ? {} : { cleanupAfter: resolveCleanupAfter(projected) }
	};
}
function reconcileTaskRecordForOperatorInspectionWithContexts(task, context, backingSessionContext) {
	const cronRecovery = resolveDurableCronTaskRecovery(task, context);
	if (cronRecovery) return projectTaskRecovered(task, cronRecovery);
	const now = Date.now();
	if (!shouldMarkLost(task, now, backingSessionContext)) return task;
	return projectTaskLost(task, now, backingSessionContext);
}
function reconcileTaskRecordForOperatorInspection(task, context = createCronRecoveryContext()) {
	return reconcileTaskRecordForOperatorInspectionWithContexts(task, context, createBackingSessionLookupContext());
}
function reconcileInspectableTasks() {
	taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
	const cronRecoveryContext = createCronRecoveryContext();
	const backingSessionContext = createBackingSessionLookupContext();
	return taskRegistryMaintenanceRuntime.listTaskRecords().map((task) => reconcileTaskRecordForOperatorInspectionWithContexts(task, cronRecoveryContext, backingSessionContext));
}
configureTaskAuditTaskProvider(reconcileInspectableTasks);
function isActiveTaskRestartBlockerStatus(status) {
	return status === "running";
}
function isTaskRestartBlocker(task) {
	return isActiveTaskRestartBlockerStatus(task.status) && !task.endedAt;
}
function getInspectableActiveTaskRestartBlockers() {
	const blockers = [];
	for (const task of reconcileInspectableTasks()) {
		if (!isTaskRestartBlocker(task)) continue;
		const blocker = {
			taskId: task.taskId,
			status: task.status,
			runtime: task.runtime
		};
		if (task.runId) blocker.runId = task.runId;
		if (task.label) blocker.label = task.label;
		if (task.task) blocker.title = task.task;
		blockers.push(blocker);
	}
	return blockers;
}
function getInspectableTaskRegistrySummary() {
	return summarizeTaskRecords(reconcileInspectableTasks());
}
function getInspectableTaskAuditSummary() {
	return summarizeTaskAuditFindings(listTaskAuditFindings({ tasks: reconcileInspectableTasks() }));
}
function reconcileTaskLookupToken(token) {
	taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
	const task = taskRegistryMaintenanceRuntime.resolveTaskForLookupToken(token);
	return task ? reconcileTaskRecordForOperatorInspection(task) : void 0;
}
function previewTaskRegistryMaintenance() {
	taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
	const now = Date.now();
	let reconciled = 0;
	let recovered = 0;
	let cleanupStamped = 0;
	let pruned = 0;
	const cronRecoveryContext = createCronRecoveryContext();
	const backingSessionContext = createBackingSessionLookupContext();
	for (const task of taskRegistryMaintenanceRuntime.listTaskRecords()) {
		if (resolveDurableCronTaskRecovery(task, cronRecoveryContext)) {
			recovered += 1;
			continue;
		}
		if (shouldMarkLost(task, now, backingSessionContext)) {
			reconciled += 1;
			continue;
		}
		if (shouldPruneTerminalTask(task, now)) {
			pruned += 1;
			continue;
		}
		if (shouldStampCleanupAfter(task)) cleanupStamped += 1;
	}
	return {
		reconciled,
		recovered,
		cleanupStamped,
		pruned
	};
}
function explainActiveTaskRetention(params) {
	if (!hasLostGraceExpired(params.task, params.now)) return {
		decision: "retained",
		reason: "lost_grace_pending"
	};
	if (params.task.runtime === "subagent") {
		const entry = findTaskSessionEntry(params.task, params.context);
		if (entry && isSubagentRecoveryWedgedEntry(entry)) return {
			decision: "would_reconcile",
			reason: "subagent_recovery_wedged",
			detail: formatSubagentRecoveryWedgedReason(entry)
		};
	}
	if (!hasBackingSession(params.task, params.context)) return {
		decision: "would_reconcile",
		reason: "backing_session_missing"
	};
	if (params.task.runtime === "cron" && !taskRegistryMaintenanceRuntime.isCronRuntimeAuthoritative()) return {
		decision: "retained",
		reason: "cron_runtime_not_authoritative"
	};
	if (params.task.runtime === "cli" && hasActiveCliRun(params.task)) return {
		decision: "retained",
		reason: "active_cli_run"
	};
	return {
		decision: "retained",
		reason: "backing_session_present"
	};
}
function getTaskRegistryMaintenanceDiagnostics() {
	taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
	const now = Date.now();
	const cronRecoveryContext = createCronRecoveryContext();
	const backingSessionContext = createBackingSessionLookupContext();
	const staleRunningTasks = [];
	for (const task of taskRegistryMaintenanceRuntime.listTaskRecords()) {
		if (task.status !== "running") continue;
		const ageMs = Math.max(0, now - taskReferenceAt(task));
		if (ageMs < TASK_STALE_RUNNING_MS) continue;
		if (resolveDurableCronTaskRecovery(task, cronRecoveryContext)) continue;
		const decision = explainActiveTaskRetention({
			task,
			now,
			context: backingSessionContext
		});
		staleRunningTasks.push({
			taskId: task.taskId,
			runtime: task.runtime,
			status: task.status,
			decision: decision.decision,
			reason: decision.reason,
			ageMs,
			...decision.detail ? { detail: decision.detail } : {},
			...task.childSessionKey ? { childSessionKey: task.childSessionKey } : {},
			...task.runId ? { runId: task.runId } : {}
		});
	}
	return { staleRunningTasks };
}
/**
* Yield control back to the event loop so that pending I/O callbacks,
* timers, and incoming requests can be processed between batches of
* synchronous task-registry maintenance work.
*/
function yieldToEventLoop() {
	return new Promise((resolve) => setImmediate(resolve));
}
function startScheduledSweep() {
	if (sweepInProgress) return;
	sweepInProgress = true;
	const clearSweepInProgress = () => {
		sweepInProgress = false;
	};
	sweepTaskRegistry().then(clearSweepInProgress, clearSweepInProgress);
}
async function runTaskRegistryMaintenance() {
	taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
	const now = Date.now();
	let reconciled = 0;
	let recovered = 0;
	let cleanupStamped = 0;
	let pruned = 0;
	const tasks = taskRegistryMaintenanceRuntime.listTaskRecords();
	const cronRecoveryContext = createCronRecoveryContext();
	const backingSessionContext = createBackingSessionLookupContext();
	const recoveryHookRegistered = hasDetachedTaskRecoveryHook();
	let processed = 0;
	for (const task of tasks) {
		const current = taskRegistryMaintenanceRuntime.getTaskById(task.taskId);
		if (!current) continue;
		const cronRecovery = resolveDurableCronTaskRecovery(current, cronRecoveryContext);
		if (cronRecovery) {
			if (markTaskRecovered(current, cronRecovery).status !== current.status) recovered += 1;
			processed += 1;
			if (processed % SWEEP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
			continue;
		}
		if (shouldMarkLost(current, now, backingSessionContext)) {
			const recovery = await tryRecoverTaskBeforeMarkLost({
				taskId: current.taskId,
				runtime: current.runtime,
				task: current,
				now
			});
			const freshAfterHook = taskRegistryMaintenanceRuntime.getTaskById(current.taskId);
			if (!freshAfterHook) {
				processed += 1;
				if (processed % SWEEP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
				continue;
			}
			const shouldRecheckFreshTask = recoveryHookRegistered || hasTaskLostDecisionInputChanged(current, freshAfterHook);
			let lostContext = backingSessionContext;
			if (shouldRecheckFreshTask) {
				lostContext = createBackingSessionLookupContext();
				if (!shouldMarkLost(freshAfterHook, now, lostContext)) {
					processed += 1;
					if (processed % SWEEP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
					continue;
				}
			}
			if (recovery.recovered) {
				recovered += 1;
				processed += 1;
				if (processed % SWEEP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
				continue;
			}
			if (markTaskLost(freshAfterHook, now, lostContext).status === "lost") reconciled += 1;
			processed += 1;
			if (processed % SWEEP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
			continue;
		}
		await cleanupTerminalAcpSession(current);
		if (shouldPruneTerminalTask(current, now) && taskRegistryMaintenanceRuntime.deleteTaskRecordById(current.taskId)) {
			pruned += 1;
			processed += 1;
			if (processed % SWEEP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
			continue;
		}
		if (shouldStampCleanupAfter(current) && taskRegistryMaintenanceRuntime.setTaskCleanupAfterById({
			taskId: current.taskId,
			cleanupAfter: resolveCleanupAfter(current)
		})) cleanupStamped += 1;
		processed += 1;
		if (processed % SWEEP_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
	}
	await cleanupOrphanedParentOwnedAcpSessions();
	if (isPluginStateDatabaseOpen()) try {
		sweepExpiredPluginStateEntries();
	} catch (error) {
		log.warn("Failed to sweep expired plugin state entries", { error });
	}
	return {
		reconciled,
		recovered,
		cleanupStamped,
		pruned
	};
}
async function sweepTaskRegistry() {
	return runTaskRegistryMaintenance();
}
function startTaskRegistryMaintenance() {
	taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
	deferredSweep = setTimeout(() => {
		deferredSweep = null;
		startScheduledSweep();
	}, 5e3);
	deferredSweep.unref?.();
	if (sweeper) return;
	sweeper = setInterval(startScheduledSweep, TASK_SWEEP_INTERVAL_MS);
	sweeper.unref?.();
}
function stopTaskRegistryMaintenance() {
	if (deferredSweep) {
		clearTimeout(deferredSweep);
		deferredSweep = null;
	}
	if (sweeper) {
		clearInterval(sweeper);
		sweeper = null;
	}
	sweepInProgress = false;
}
const stopTaskRegistryMaintenanceForTests = stopTaskRegistryMaintenance;
function setTaskRegistryMaintenanceRuntimeForTests(runtime) {
	taskRegistryMaintenanceRuntime = runtime;
}
function resetTaskRegistryMaintenanceRuntimeForTests() {
	taskRegistryMaintenanceRuntime = defaultTaskRegistryMaintenanceRuntime;
	configuredCronStorePath = void 0;
	configuredCronRuntimeAuthoritative = false;
}
function configureTaskRegistryMaintenance(options) {
	configuredCronStorePath = options.cronStorePath?.trim() || void 0;
	if (options.cronRuntimeAuthoritative !== void 0) configuredCronRuntimeAuthoritative = options.cronRuntimeAuthoritative;
}
function getReconciledTaskById(taskId) {
	const task = getTaskById(taskId);
	return task ? reconcileTaskRecordForOperatorInspection(task) : void 0;
}
//#endregion
export { sweepTaskRegistry as _, getReconciledTaskById as a, reconcileInspectableTasks as c, resetTaskRegistryMaintenanceRuntimeForTests as d, runTaskRegistryMaintenance as f, stopTaskRegistryMaintenanceForTests as g, stopTaskRegistryMaintenance as h, getInspectableTaskRegistrySummary as i, reconcileTaskLookupToken as l, startTaskRegistryMaintenance as m, getInspectableActiveTaskRestartBlockers as n, getTaskRegistryMaintenanceDiagnostics as o, setTaskRegistryMaintenanceRuntimeForTests as p, getInspectableTaskAuditSummary as r, previewTaskRegistryMaintenance as s, configureTaskRegistryMaintenance as t, reconcileTaskRecordForOperatorInspection as u };
