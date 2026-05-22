import { An as preprocess, At as boolean, Et as array, Rn as string, Tn as object, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as ZodIssueCode } from "./compat-bCpUj7Jq.js";
import { a as normalizeDiagnosticTraceparent, t as DIAGNOSTIC_TRACEPARENT_PATTERN } from "./diagnostic-trace-context-pure-DngS4fbR.js";
import "./diagnostic-trace-context-BhiYlOGB.js";
import { t as createSubsystemLogger } from "./subsystem-A7mlQkJn.js";
import { n as registerDiagnosticContinuationQueueMetricsProvider } from "./diagnostic-continuation-queues-gN3DjxwG.js";
import { a as normalizeContinuationTargetKeys, i as normalizeContinuationTargetKey, t as CONTINUATION_DELEGATE_FANOUT_MODES } from "./targeting-pure-DU9HQ1D9.js";
import { i as failFlow, l as listTaskFlowRecords, o as finishFlow, r as deleteTaskFlowRecordById, t as createManagedTaskFlow, u as listTaskFlowsForOwnerKey } from "./task-flow-runtime-internal-CX8Uaw6G.js";
import "./targeting-CgpAQIJ1.js";
//#region src/auto-reply/continuation/delegate-store.ts
/**
* Continuation delegate store — pure TaskFlow-backed.
*
* Every delegate operation goes through TaskFlow (SQLite persistence).
* Zero volatile Maps. Delegates survive gateway restarts by design.
*
* Adds Zod validation on state payloads, a `releasedAt` audit trail, and
* `failFlow` for corrupt records on top of the base TaskFlow store.
*
* RFC: docs/design/continue-work-signal-v2.md §5.4
*/
const log = createSubsystemLogger("continuation/delegate-store");
const CONTINUATION_DELEGATE_CONTROLLER_ID = "core/continuation-delegate";
const CONTINUATION_POST_COMPACTION_CONTROLLER_ID = "core/continuation-post-compaction";
const TraceparentStateSchema = preprocess((value) => value === null ? void 0 : value, string().regex(new RegExp(DIAGNOSTIC_TRACEPARENT_PATTERN)).refine((value) => normalizeDiagnosticTraceparent(value) !== void 0, { message: "invalid W3C traceparent" }).transform((value) => normalizeDiagnosticTraceparent(value)).optional()).optional();
const PendingDelegateStateSchema = object({
	kind: literal("continuation_delegate"),
	task: string().min(1),
	delayMs: number().int().nonnegative().optional(),
	silent: boolean().optional(),
	silentWake: boolean().optional(),
	postCompaction: boolean().optional(),
	firstArmedAt: number().int().nonnegative().optional(),
	targetSessionKey: string().min(1).optional(),
	targetSessionKeys: array(string().min(1)).optional(),
	fanoutMode: _enum(CONTINUATION_DELEGATE_FANOUT_MODES).optional(),
	traceparent: TraceparentStateSchema
}).superRefine((state, ctx) => {
	const hasSilent = state.silent === true;
	const hasSilentWake = state.silentWake === true;
	const hasPostCompaction = state.postCompaction === true;
	const flagCount = [
		hasSilent,
		hasSilentWake,
		hasPostCompaction
	].filter(Boolean).length;
	if (state.fanoutMode && (state.targetSessionKey || state.targetSessionKeys && state.targetSessionKeys.length > 0)) {
		ctx.addIssue({
			code: ZodIssueCode.custom,
			message: "continuation delegate payload cannot combine explicit targets with fanoutMode"
		});
		return;
	}
	if (flagCount <= 1 || hasSilent && hasSilentWake && !hasPostCompaction) return;
	ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "continuation delegate payload has incompatible mode flags"
	});
});
const CONTINUATION_QUEUE_HISTORY_LIMIT = 8;
let continuationQueueDiagnosticsLastSampleAt;
const continuationQueueDiagnosticsHistory = [];
function buildDelegateGoal(delegate) {
	const task = delegate.task.trim();
	const isPostCompaction = delegate.mode === "post-compaction";
	if (!task) return isPostCompaction ? "Post-compaction continuation delegate" : "Continuation delegate";
	const excerpt = task.length > 80 ? `${task.slice(0, 77)}...` : task;
	return isPostCompaction ? `Post-compaction delegate: ${excerpt}` : `Continuation delegate: ${excerpt}`;
}
function buildDelegateState(delegate) {
	const targetSessionKey = normalizeContinuationTargetKey(delegate.targetSessionKey);
	const targetSessionKeys = normalizeContinuationTargetKeys(delegate.targetSessionKeys);
	const traceparent = normalizeDiagnosticTraceparent(delegate.traceparent);
	return {
		kind: "continuation_delegate",
		task: delegate.task,
		...delegate.delayMs !== void 0 ? { delayMs: delegate.delayMs } : {},
		...delegate.mode === "silent" ? { silent: true } : {},
		...delegate.mode === "silent-wake" ? { silentWake: true } : {},
		...delegate.mode === "post-compaction" ? { postCompaction: true } : {},
		...delegate.firstArmedAt !== void 0 ? { firstArmedAt: delegate.firstArmedAt } : {},
		...targetSessionKey ? { targetSessionKey } : {},
		...targetSessionKeys.length > 0 ? { targetSessionKeys } : {},
		...delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {},
		...traceparent ? { traceparent } : {}
	};
}
function isPendingDelegateFlow(flow) {
	return flow.syncMode === "managed" && flow.controllerId === "core/continuation-delegate";
}
function isPostCompactionDelegateFlow(flow) {
	return flow.syncMode === "managed" && flow.controllerId === "core/continuation-post-compaction";
}
function isContinuationDelegateFlow(flow) {
	return isPendingDelegateFlow(flow) || isPostCompactionDelegateFlow(flow);
}
function listQueuedPendingFlows(sessionKey) {
	return listTaskFlowsForOwnerKey(sessionKey).filter((flow) => isPendingDelegateFlow(flow) && flow.status === "queued").toSorted((a, b) => a.createdAt - b.createdAt);
}
function listQueuedPostCompactionFlows(sessionKey) {
	return listTaskFlowsForOwnerKey(sessionKey).filter((flow) => isPostCompactionDelegateFlow(flow) && flow.status === "queued").toSorted((a, b) => a.createdAt - b.createdAt);
}
function decodeDelegateState(flow) {
	const parsed = PendingDelegateStateSchema.safeParse(flow.stateJson);
	return parsed.success ? parsed.data : void 0;
}
function countFlowsChangedSince(flows, status, since, now) {
	if (since === void 0) return 0;
	return flows.filter((flow) => {
		const changedAt = flow.endedAt ?? flow.updatedAt;
		return flow.status === status && changedAt > since && changedAt <= now;
	}).length;
}
function createEmptyOwnerQueueSample(sessionKey) {
	return {
		sessionKey,
		pendingQueued: 0,
		pendingRunnable: 0,
		pendingScheduled: 0,
		stagedPostCompaction: 0,
		invalidQueued: 0,
		totalQueued: 0
	};
}
function noteOwnerQueuedFlow(owner, flow, now) {
	owner.totalQueued += 1;
	const queuedAgeMs = Math.max(0, now - flow.createdAt);
	owner.oldestQueuedAgeMs = Math.max(owner.oldestQueuedAgeMs ?? 0, queuedAgeMs);
	owner.newestQueuedAgeMs = owner.newestQueuedAgeMs === void 0 ? queuedAgeMs : Math.min(owner.newestQueuedAgeMs, queuedAgeMs);
}
function buildContinuationQueueDiagnostics(now = Date.now()) {
	const flows = listTaskFlowRecords().filter(isContinuationDelegateFlow);
	const intervalMs = continuationQueueDiagnosticsLastSampleAt !== void 0 ? Math.max(0, now - continuationQueueDiagnosticsLastSampleAt) : void 0;
	const previousSampleAt = continuationQueueDiagnosticsLastSampleAt;
	const enqueuedSinceLastSample = previousSampleAt === void 0 ? 0 : flows.filter((flow) => flow.createdAt > previousSampleAt && flow.createdAt <= now).length;
	const drainedSinceLastSample = countFlowsChangedSince(flows, "succeeded", previousSampleAt, now);
	const failedSinceLastSample = countFlowsChangedSince(flows, "failed", previousSampleAt, now);
	const owners = /* @__PURE__ */ new Map();
	let pendingQueued = 0;
	let pendingRunnable = 0;
	let pendingScheduled = 0;
	let stagedPostCompaction = 0;
	let invalidQueued = 0;
	for (const flow of flows) {
		if (flow.status !== "queued") continue;
		const owner = owners.get(flow.ownerKey) ?? createEmptyOwnerQueueSample(flow.ownerKey);
		owners.set(flow.ownerKey, owner);
		noteOwnerQueuedFlow(owner, flow, now);
		if (isPostCompactionDelegateFlow(flow)) {
			stagedPostCompaction += 1;
			owner.stagedPostCompaction += 1;
			continue;
		}
		pendingQueued += 1;
		owner.pendingQueued += 1;
		const state = decodeDelegateState(flow);
		if (!state) {
			invalidQueued += 1;
			owner.invalidQueued += 1;
			continue;
		}
		if (delegateDueAt(flow, state) <= now) {
			pendingRunnable += 1;
			owner.pendingRunnable += 1;
		} else {
			pendingScheduled += 1;
			owner.pendingScheduled += 1;
		}
	}
	const totalQueued = pendingQueued + stagedPostCompaction;
	const historyPoint = {
		sampledAt: now,
		...intervalMs !== void 0 ? { intervalMs } : {},
		totalQueued,
		pendingRunnable,
		pendingScheduled,
		stagedPostCompaction,
		invalidQueued,
		enqueued: enqueuedSinceLastSample,
		drained: drainedSinceLastSample,
		failed: failedSinceLastSample
	};
	continuationQueueDiagnosticsHistory.push(historyPoint);
	if (continuationQueueDiagnosticsHistory.length > CONTINUATION_QUEUE_HISTORY_LIMIT) continuationQueueDiagnosticsHistory.splice(0, continuationQueueDiagnosticsHistory.length - CONTINUATION_QUEUE_HISTORY_LIMIT);
	continuationQueueDiagnosticsLastSampleAt = now;
	if (flows.length === 0 && totalQueued === 0 && enqueuedSinceLastSample === 0 && drainedSinceLastSample === 0 && failedSinceLastSample === 0) return;
	const rateFields = intervalMs !== void 0 && intervalMs > 0 ? {
		enqueueRatePerMinute: enqueuedSinceLastSample * 6e4 / intervalMs,
		drainRatePerMinute: drainedSinceLastSample * 6e4 / intervalMs,
		failedRatePerMinute: failedSinceLastSample * 6e4 / intervalMs
	} : {};
	return {
		sampledAt: now,
		...intervalMs !== void 0 ? { intervalMs } : {},
		totalQueued,
		pendingQueued,
		pendingRunnable,
		pendingScheduled,
		stagedPostCompaction,
		invalidQueued,
		enqueuedSinceLastSample,
		drainedSinceLastSample,
		failedSinceLastSample,
		...rateFields,
		topQueues: [...owners.values()].toSorted((a, b) => b.totalQueued - a.totalQueued || a.sessionKey.localeCompare(b.sessionKey)).slice(0, 8),
		queueDepthHistory: [...continuationQueueDiagnosticsHistory]
	};
}
registerDiagnosticContinuationQueueMetricsProvider(buildContinuationQueueDiagnostics);
function delegateDueAt(flow, state) {
	return flow.createdAt + (state.delayMs ?? 0);
}
function flowToDelegate(flow, state) {
	let mode;
	if (state.postCompaction === true) mode = "post-compaction";
	else if (state.silentWake === true) mode = "silent-wake";
	else if (state.silent === true) mode = "silent";
	return {
		task: state.task,
		...state.delayMs !== void 0 ? { delayMs: state.delayMs } : {},
		...mode !== void 0 ? { mode } : {},
		...state.firstArmedAt !== void 0 ? { firstArmedAt: state.firstArmedAt } : {},
		...state.targetSessionKey ? { targetSessionKey: state.targetSessionKey } : {},
		...state.targetSessionKeys && state.targetSessionKeys.length > 0 ? { targetSessionKeys: state.targetSessionKeys } : {},
		...state.fanoutMode ? { fanoutMode: state.fanoutMode } : {},
		...state.traceparent ? { traceparent: state.traceparent } : {},
		flowId: flow.flowId,
		expectedRevision: flow.revision
	};
}
/**
* Enqueue a delegate from the `continue_delegate` tool.
*/
function enqueuePendingDelegate(sessionKey, delegate) {
	const isPostCompaction = delegate.mode === "post-compaction";
	createManagedTaskFlow({
		ownerKey: sessionKey,
		controllerId: isPostCompaction ? CONTINUATION_POST_COMPACTION_CONTROLLER_ID : CONTINUATION_DELEGATE_CONTROLLER_ID,
		notifyPolicy: "silent",
		goal: buildDelegateGoal(delegate),
		currentStep: isPostCompaction ? "Staged for release after compaction" : "Queued for continuation dispatch",
		stateJson: buildDelegateState(delegate)
	});
}
/**
* Consume pending delegates for a session whose `delayMs` horizon has matured.
*
* Filters by `Date.now() >= flow.createdAt + (state.delayMs ?? 0)`. Matured
* entries are finished with the `releasedAt` audit trail and returned in FIFO
* order. Unmatured entries are left in `queued` state to be re-checked on the
* next consume cycle (filter-at-consume; preserves `mode=silent` no-wake
* semantics so a quiet-channel session is not woken solely to drain a delegate
* whose horizon has not yet matured).
*
* Skips corrupt payloads via `failFlow`. Only pushes delegates where
* `finishFlow` was applied (concurrency-safe).
*
* Callers that need to know when to retry the consume cycle in a quiet channel
* should call `peekSoonestUnmaturedDelegateDueAt(sessionKey)` immediately after
* this returns. Pairing avoids a separate query path.
*
* Maturity contract for downstream callers: each returned delegate has
* already passed its `createdAt + delayMs` horizon. The `delayMs` field on
* the returned object is historical metadata — useful for telemetry
* discriminators — and MUST NOT be used as a fresh scheduling instruction.
* Re-arming a `setTimeout(delayMs)` against a consumed delegate charges the
* wait twice and drifts recipient drains by approximately the original delay.
*/
function consumePendingDelegates(sessionKey) {
	const delegates = [];
	const now = Date.now();
	for (const flow of listQueuedPendingFlows(sessionKey)) {
		const state = decodeDelegateState(flow);
		if (!state) {
			log.warn(`[continuation:delegate-decode-failed] flowId=${flow.flowId} session=${sessionKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`);
			failFlow({
				flowId: flow.flowId,
				expectedRevision: flow.revision,
				currentStep: "Rejected invalid continuation payload",
				blockedSummary: "Pending continuation delegate payload could not be decoded."
			});
			continue;
		}
		if (now < delegateDueAt(flow, state)) continue;
		const finished = finishFlow({
			flowId: flow.flowId,
			expectedRevision: flow.revision,
			currentStep: "Released to continuation scheduler",
			stateJson: {
				...state,
				releasedAt: Date.now()
			}
		});
		if (!finished.applied || !finished.flow) continue;
		delegates.push(flowToDelegate(finished.flow, state));
	}
	return delegates;
}
/**
* Peek the soonest `dueAt` (createdAt + delayMs) across queued, unmatured
* pending delegates for a session.
*
* Returns `undefined` if there are no unmatured entries. Used by
* `dispatchToolDelegates` to arm a hedge `setTimeout` so unmatured entries
* still fire in fully-quiet channels where no further response-finalize
* arrives.
*/
function peekSoonestUnmaturedDelegateDueAt(sessionKey) {
	const now = Date.now();
	let soonest;
	for (const flow of listQueuedPendingFlows(sessionKey)) {
		const state = decodeDelegateState(flow);
		if (!state) continue;
		const dueAt = delegateDueAt(flow, state);
		if (dueAt <= now) continue;
		if (soonest === void 0 || dueAt < soonest) soonest = dueAt;
	}
	return soonest;
}
/**
* Count pending delegates without consuming them.
*/
function pendingDelegateCount(sessionKey) {
	return listQueuedPendingFlows(sessionKey).length;
}
function getContinuationDelegateQueueDepths(sessionKey, now = Date.now()) {
	const pendingFlows = listQueuedPendingFlows(sessionKey);
	let pendingRunnable = 0;
	for (const flow of pendingFlows) {
		const state = decodeDelegateState(flow);
		if (state && delegateDueAt(flow, state) <= now) pendingRunnable += 1;
	}
	const stagedPostCompaction = listQueuedPostCompactionFlows(sessionKey).length;
	return {
		pendingQueued: pendingFlows.length,
		pendingRunnable,
		pendingScheduled: pendingFlows.length - pendingRunnable,
		stagedPostCompaction,
		totalQueued: pendingFlows.length + stagedPostCompaction
	};
}
/**
* Cancel all pending delegates for a session (both regular and post-compaction).
*/
function cancelPendingDelegates(sessionKey) {
	for (const flow of listTaskFlowsForOwnerKey(sessionKey).filter((f) => isPendingDelegateFlow(f) || isPostCompactionDelegateFlow(f))) deleteTaskFlowRecordById(flow.flowId);
}
/**
* Stage a delegate for release after compaction.
*/
function stagePostCompactionDelegate(sessionKey, delegate) {
	enqueuePendingDelegate(sessionKey, {
		task: delegate.task,
		mode: "post-compaction",
		firstArmedAt: delegate.firstArmedAt ?? delegate.stagedAt,
		...delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {},
		...delegate.targetSessionKeys ? { targetSessionKeys: delegate.targetSessionKeys } : {},
		...delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {},
		...delegate.traceparent ? { traceparent: delegate.traceparent } : {}
	});
}
/**
* Consume staged post-compaction delegates. Same lifecycle as consumePendingDelegates.
*/
function consumeStagedPostCompactionDelegates(sessionKey) {
	const delegates = [];
	for (const flow of listQueuedPostCompactionFlows(sessionKey)) {
		const state = decodeDelegateState(flow);
		if (!state) {
			log.warn(`[continuation:post-compaction-decode-failed] flowId=${flow.flowId} session=${sessionKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`);
			failFlow({
				flowId: flow.flowId,
				expectedRevision: flow.revision,
				currentStep: "Rejected invalid post-compaction payload",
				blockedSummary: "Staged post-compaction delegate payload could not be decoded."
			});
			continue;
		}
		if (!finishFlow({
			flowId: flow.flowId,
			expectedRevision: flow.revision,
			currentStep: "Released after compaction",
			stateJson: {
				...state,
				releasedAt: Date.now()
			}
		}).applied) continue;
		delegates.push(flowToDelegate(flow, state));
	}
	return delegates;
}
function stagedPostCompactionDelegateCount(sessionKey) {
	return listQueuedPostCompactionFlows(sessionKey).length;
}
const delayedReservations = /* @__PURE__ */ new Map();
function addDelayedContinuationReservation(sessionKey, reservation) {
	const existing = delayedReservations.get(sessionKey);
	if (existing) existing.push(reservation);
	else delayedReservations.set(sessionKey, [reservation]);
}
function takeDelayedContinuationReservation(sessionKey, reservationId) {
	const list = delayedReservations.get(sessionKey);
	if (!list) return null;
	const idx = list.findIndex((r) => r.id === reservationId);
	if (idx === -1) return null;
	const [reservation] = list.splice(idx, 1);
	if (list.length === 0) delayedReservations.delete(sessionKey);
	return reservation;
}
function delayedContinuationReservationCount(sessionKey) {
	return delayedReservations.get(sessionKey)?.length ?? 0;
}
function highestDelayedContinuationReservationHop(sessionKey) {
	const list = delayedReservations.get(sessionKey);
	if (!list || list.length === 0) return 0;
	return Math.max(...list.map((r) => r.plannedHop));
}
function clearDelayedContinuationReservations(sessionKey) {
	delayedReservations.delete(sessionKey);
}
//#endregion
export { consumeStagedPostCompactionDelegates as a, getContinuationDelegateQueueDepths as c, pendingDelegateCount as d, stagePostCompactionDelegate as f, consumePendingDelegates as i, highestDelayedContinuationReservationHop as l, takeDelayedContinuationReservation as m, cancelPendingDelegates as n, delayedContinuationReservationCount as o, stagedPostCompactionDelegateCount as p, clearDelayedContinuationReservations as r, enqueuePendingDelegate as s, addDelayedContinuationReservation as t, peekSoonestUnmaturedDelegateDueAt as u };
