import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as getRegisteredDetachedTaskLifecycleRuntime } from "./detached-task-runtime-state-B0mh7AbV.js";
import { A as deleteTaskFlowRecordById, E as setTaskRunDeliveryStatusByRunId, H as updateFlowRecordByIdExpectedRevision, L as listTaskFlowsForOwnerKey, M as findLatestTaskFlowForOwnerKey, P as getTaskFlowById, R as requestFlowCancel, S as recordTaskProgressByRunId, a as finalizeTaskRunByRunId$1, k as createTaskFlowForTask, l as isParentFlowLinkError, m as listTasksForFlowId, n as createTaskRecord, s as getTaskById, t as cancelTaskById, u as linkTaskToFlowById, y as markTaskRunningByRunId } from "./task-registry-B9ljq8Nk.js";
import { n as summarizeTaskRecords } from "./task-registry.summary-BwpoHlXv.js";
import "./runtime-internal-2F71tA3B.js";
//#region src/tasks/task-flow-owner-access.ts
function getTaskFlowByIdForOwner(params) {
	const flow = getTaskFlowById(params.flowId);
	return flow && normalizeOptionalString(flow.ownerKey) === normalizeOptionalString(params.callerOwnerKey) ? flow : void 0;
}
function listTaskFlowsForOwner(params) {
	const ownerKey = normalizeOptionalString(params.callerOwnerKey);
	return ownerKey ? listTaskFlowsForOwnerKey(ownerKey) : [];
}
function findLatestTaskFlowForOwner(params) {
	const ownerKey = normalizeOptionalString(params.callerOwnerKey);
	return ownerKey ? findLatestTaskFlowForOwnerKey(ownerKey) : void 0;
}
function resolveTaskFlowForLookupTokenForOwner(params) {
	const direct = getTaskFlowByIdForOwner({
		flowId: params.token,
		callerOwnerKey: params.callerOwnerKey
	});
	if (direct) return direct;
	const normalizedToken = normalizeOptionalString(params.token);
	const normalizedCallerOwnerKey = normalizeOptionalString(params.callerOwnerKey);
	if (!normalizedToken || normalizedToken !== normalizedCallerOwnerKey) return;
	return findLatestTaskFlowForOwner({ callerOwnerKey: normalizedCallerOwnerKey });
}
//#endregion
//#region src/tasks/task-executor.ts
const log = createSubsystemLogger("tasks/executor");
function isOneTaskFlowEligible(task) {
	if (task.parentFlowId?.trim() || task.scopeKind !== "session") return false;
	if (task.deliveryStatus === "not_applicable") return false;
	return task.runtime === "acp" || task.runtime === "subagent";
}
function ensureSingleTaskFlow(params) {
	if (!isOneTaskFlowEligible(params.task)) return params.task;
	try {
		const flow = createTaskFlowForTask({
			task: params.task,
			requesterOrigin: params.requesterOrigin
		});
		const linked = linkTaskToFlowById({
			taskId: params.task.taskId,
			flowId: flow.flowId
		});
		if (!linked) {
			deleteTaskFlowRecordById(flow.flowId);
			return params.task;
		}
		if (linked.parentFlowId !== flow.flowId) {
			deleteTaskFlowRecordById(flow.flowId);
			return linked;
		}
		return linked;
	} catch (error) {
		log.warn("Failed to create one-task flow for detached run", {
			taskId: params.task.taskId,
			runId: params.task.runId,
			error
		});
		return params.task;
	}
}
function createQueuedTaskRun(params) {
	return ensureSingleTaskFlow({
		task: createTaskRecord({
			...params,
			status: "queued"
		}),
		requesterOrigin: params.requesterOrigin
	});
}
function getFlowTaskSummary(flowId) {
	return summarizeTaskRecords(listTasksForFlowId(flowId));
}
function createRunningTaskRun(params) {
	return ensureSingleTaskFlow({
		task: createTaskRecord({
			...params,
			status: "running"
		}),
		requesterOrigin: params.requesterOrigin
	});
}
function startTaskRunByRunId(params) {
	return markTaskRunningByRunId(params);
}
function recordTaskRunProgressByRunId(params) {
	return recordTaskProgressByRunId(params);
}
function completeTaskRunByRunId(params) {
	return finalizeTaskRunByRunId({
		...params,
		status: "succeeded"
	});
}
function finalizeTaskRunByRunId(params) {
	return finalizeTaskRunByRunId$1(params);
}
function failTaskRunByRunId(params) {
	return finalizeTaskRunByRunId({
		...params,
		status: params.status ?? "failed"
	});
}
function setDetachedTaskDeliveryStatusByRunId(params) {
	return setTaskRunDeliveryStatusByRunId(params);
}
function isActiveTaskStatus(status) {
	return status === "queued" || status === "running";
}
function isTerminalFlowStatus(status) {
	return status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost";
}
function markFlowCancelRequested(flow) {
	if (flow.cancelRequestedAt != null) return flow;
	const result = requestFlowCancel({
		flowId: flow.flowId,
		expectedRevision: flow.revision
	});
	if (result.applied) return result.flow;
	return {
		reason: result.reason === "revision_conflict" ? "Flow changed while cancellation was in progress." : "Flow not found.",
		flow: result.current ?? getTaskFlowById(flow.flowId)
	};
}
function cancelManagedFlowAfterChildrenSettle(flow, endedAt) {
	const result = updateFlowRecordByIdExpectedRevision({
		flowId: flow.flowId,
		expectedRevision: flow.revision,
		patch: {
			status: "cancelled",
			blockedTaskId: null,
			blockedSummary: null,
			waitJson: null,
			endedAt,
			updatedAt: endedAt
		}
	});
	if (result.applied) return result.flow;
	return {
		reason: result.reason === "revision_conflict" ? "Flow changed while cancellation was in progress." : "Flow not found.",
		flow: result.current ?? getTaskFlowById(flow.flowId)
	};
}
function mapRunTaskInFlowCreateError(params) {
	const flow = getTaskFlowById(params.flowId);
	if (isParentFlowLinkError(params.error)) {
		if (params.error.code === "cancel_requested") return {
			found: true,
			created: false,
			reason: "Flow cancellation has already been requested.",
			...flow ? { flow } : {}
		};
		if (params.error.code === "terminal") return {
			found: true,
			created: false,
			reason: `Flow is already ${flow?.status ?? params.error.details?.status ?? "terminal"}.`,
			...flow ? { flow } : {}
		};
		if (params.error.code === "parent_flow_not_found") return {
			found: false,
			created: false,
			reason: "Flow not found."
		};
	}
	throw params.error;
}
function runTaskInFlow(params) {
	const flow = getTaskFlowById(params.flowId);
	if (!flow) return {
		found: false,
		created: false,
		reason: "Flow not found."
	};
	if (flow.syncMode !== "managed") return {
		found: true,
		created: false,
		reason: "Flow does not accept managed child tasks.",
		flow
	};
	if (flow.cancelRequestedAt != null) return {
		found: true,
		created: false,
		reason: "Flow cancellation has already been requested.",
		flow
	};
	if (isTerminalFlowStatus(flow.status)) return {
		found: true,
		created: false,
		reason: `Flow is already ${flow.status}.`,
		flow
	};
	const common = {
		runtime: params.runtime,
		sourceId: params.sourceId,
		ownerKey: flow.ownerKey,
		scopeKind: "session",
		requesterOrigin: flow.requesterOrigin,
		parentFlowId: flow.flowId,
		childSessionKey: params.childSessionKey,
		parentTaskId: params.parentTaskId,
		agentId: params.agentId,
		runId: params.runId,
		label: params.label,
		task: params.task,
		preferMetadata: params.preferMetadata,
		notifyPolicy: params.notifyPolicy,
		deliveryStatus: params.deliveryStatus ?? "pending"
	};
	let task;
	try {
		task = params.status === "running" ? createRunningTaskRun({
			...common,
			startedAt: params.startedAt,
			lastEventAt: params.lastEventAt,
			progressSummary: params.progressSummary
		}) : createQueuedTaskRun(common);
	} catch (error) {
		return mapRunTaskInFlowCreateError({
			error,
			flowId: flow.flowId
		});
	}
	return {
		found: true,
		created: true,
		flow: getTaskFlowById(flow.flowId) ?? flow,
		task
	};
}
function runTaskInFlowForOwner(params) {
	const flow = getTaskFlowByIdForOwner({
		flowId: params.flowId,
		callerOwnerKey: params.callerOwnerKey
	});
	if (!flow) return {
		found: false,
		created: false,
		reason: "Flow not found."
	};
	return runTaskInFlow({
		flowId: flow.flowId,
		runtime: params.runtime,
		sourceId: params.sourceId,
		childSessionKey: params.childSessionKey,
		parentTaskId: params.parentTaskId,
		agentId: params.agentId,
		runId: params.runId,
		label: params.label,
		task: params.task,
		preferMetadata: params.preferMetadata,
		notifyPolicy: params.notifyPolicy,
		deliveryStatus: params.deliveryStatus,
		status: params.status,
		startedAt: params.startedAt,
		lastEventAt: params.lastEventAt,
		progressSummary: params.progressSummary
	});
}
async function cancelFlowById(params) {
	const flow = getTaskFlowById(params.flowId);
	if (!flow) return {
		found: false,
		cancelled: false,
		reason: "Flow not found."
	};
	if (isTerminalFlowStatus(flow.status)) return {
		found: true,
		cancelled: false,
		reason: `Flow is already ${flow.status}.`,
		flow,
		tasks: listTasksForFlowId(flow.flowId)
	};
	const cancelRequestedFlow = markFlowCancelRequested(flow);
	if ("reason" in cancelRequestedFlow) return {
		found: true,
		cancelled: false,
		reason: cancelRequestedFlow.reason,
		flow: cancelRequestedFlow.flow,
		tasks: listTasksForFlowId(flow.flowId)
	};
	const activeTasks = listTasksForFlowId(flow.flowId).filter((task) => isActiveTaskStatus(task.status));
	for (const task of activeTasks) await cancelDetachedTaskRunById({
		cfg: params.cfg,
		taskId: task.taskId
	});
	const refreshedTasks = listTasksForFlowId(flow.flowId);
	if (refreshedTasks.filter((task) => isActiveTaskStatus(task.status)).length > 0) return {
		found: true,
		cancelled: false,
		reason: "One or more child tasks are still active.",
		flow: getTaskFlowById(flow.flowId) ?? cancelRequestedFlow,
		tasks: refreshedTasks
	};
	const now = Date.now();
	const refreshedFlow = getTaskFlowById(flow.flowId) ?? cancelRequestedFlow;
	if (isTerminalFlowStatus(refreshedFlow.status)) return {
		found: true,
		cancelled: refreshedFlow.status === "cancelled",
		reason: refreshedFlow.status === "cancelled" ? void 0 : `Flow is already ${refreshedFlow.status}.`,
		flow: refreshedFlow,
		tasks: refreshedTasks
	};
	const updatedFlow = cancelManagedFlowAfterChildrenSettle(refreshedFlow, now);
	if ("reason" in updatedFlow) return {
		found: true,
		cancelled: false,
		reason: updatedFlow.reason,
		flow: updatedFlow.flow,
		tasks: refreshedTasks
	};
	return {
		found: true,
		cancelled: true,
		flow: updatedFlow,
		tasks: refreshedTasks
	};
}
async function cancelFlowByIdForOwner(params) {
	const flow = getTaskFlowByIdForOwner({
		flowId: params.flowId,
		callerOwnerKey: params.callerOwnerKey
	});
	if (!flow) return {
		found: false,
		cancelled: false,
		reason: "Flow not found."
	};
	return cancelFlowById({
		cfg: params.cfg,
		flowId: flow.flowId
	});
}
async function cancelDetachedTaskRunById(params) {
	if (!getTaskById(params.taskId)) return cancelTaskById(params);
	const registeredRuntime = getRegisteredDetachedTaskLifecycleRuntime();
	if (registeredRuntime) {
		const cancelled = await registeredRuntime.cancelDetachedTaskRunById(params);
		if (cancelled.found) return cancelled;
	}
	return cancelTaskById(params);
}
//#endregion
export { resolveTaskFlowForLookupTokenForOwner as _, createQueuedTaskRun as a, finalizeTaskRunByRunId as c, runTaskInFlowForOwner as d, setDetachedTaskDeliveryStatusByRunId as f, listTaskFlowsForOwner as g, getTaskFlowByIdForOwner as h, completeTaskRunByRunId as i, getFlowTaskSummary as l, findLatestTaskFlowForOwner as m, cancelFlowById as n, createRunningTaskRun as o, startTaskRunByRunId as p, cancelFlowByIdForOwner as r, failTaskRunByRunId as s, cancelDetachedTaskRunById as t, recordTaskRunProgressByRunId as u };
