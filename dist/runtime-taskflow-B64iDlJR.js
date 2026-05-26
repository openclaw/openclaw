import { o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { B as resumeFlow, N as finishFlow, O as createManagedTaskFlow, R as requestFlowCancel, V as setFlowWaiting, j as failFlow } from "./task-registry-B9ljq8Nk.js";
import { _ as resolveTaskFlowForLookupTokenForOwner, d as runTaskInFlowForOwner, g as listTaskFlowsForOwner, h as getTaskFlowByIdForOwner, l as getFlowTaskSummary, m as findLatestTaskFlowForOwner, r as cancelFlowByIdForOwner } from "./task-executor-BGVJzIov.js";
//#region src/plugins/runtime/runtime-taskflow.ts
function assertSessionKey(sessionKey, errorMessage) {
	const normalized = sessionKey?.trim();
	if (!normalized) throw new Error(errorMessage);
	return normalized;
}
function asManagedTaskFlowRecord(flow) {
	if (!flow || flow.syncMode !== "managed" || !flow.controllerId) return;
	return flow;
}
function resolveManagedFlowForOwner(params) {
	const flow = getTaskFlowByIdForOwner({
		flowId: params.flowId,
		callerOwnerKey: params.ownerKey
	});
	if (!flow) return {
		ok: false,
		code: "not_found"
	};
	const managed = asManagedTaskFlowRecord(flow);
	if (!managed) return {
		ok: false,
		code: "not_managed",
		current: flow
	};
	return {
		ok: true,
		flow: managed
	};
}
function mapFlowUpdateResult(result) {
	if (result.applied) {
		const managed = asManagedTaskFlowRecord(result.flow);
		if (!managed) return {
			applied: false,
			code: "not_managed",
			current: result.flow
		};
		return {
			applied: true,
			flow: managed
		};
	}
	return {
		applied: false,
		code: result.reason,
		...result.current ? { current: result.current } : {}
	};
}
function createBoundTaskFlowRuntime(params) {
	const ownerKey = assertSessionKey(params.sessionKey, "TaskFlow runtime requires a bound sessionKey.");
	const requesterOrigin = params.requesterOrigin ? normalizeDeliveryContext(params.requesterOrigin) : void 0;
	return {
		sessionKey: ownerKey,
		...requesterOrigin ? { requesterOrigin } : {},
		createManaged: (input) => createManagedTaskFlow({
			ownerKey,
			controllerId: input.controllerId,
			requesterOrigin,
			status: input.status,
			notifyPolicy: input.notifyPolicy,
			goal: input.goal,
			currentStep: input.currentStep,
			stateJson: input.stateJson,
			waitJson: input.waitJson,
			cancelRequestedAt: input.cancelRequestedAt,
			createdAt: input.createdAt,
			updatedAt: input.updatedAt,
			endedAt: input.endedAt
		}),
		get: (flowId) => getTaskFlowByIdForOwner({
			flowId,
			callerOwnerKey: ownerKey
		}),
		list: () => listTaskFlowsForOwner({ callerOwnerKey: ownerKey }),
		findLatest: () => findLatestTaskFlowForOwner({ callerOwnerKey: ownerKey }),
		resolve: (token) => resolveTaskFlowForLookupTokenForOwner({
			token,
			callerOwnerKey: ownerKey
		}),
		getTaskSummary: (flowId) => {
			const flow = getTaskFlowByIdForOwner({
				flowId,
				callerOwnerKey: ownerKey
			});
			return flow ? getFlowTaskSummary(flow.flowId) : void 0;
		},
		setWaiting: (input) => {
			const flow = resolveManagedFlowForOwner({
				flowId: input.flowId,
				ownerKey
			});
			if (!flow.ok) return {
				applied: false,
				code: flow.code,
				...flow.current ? { current: flow.current } : {}
			};
			return mapFlowUpdateResult(setFlowWaiting({
				flowId: flow.flow.flowId,
				expectedRevision: input.expectedRevision,
				currentStep: input.currentStep,
				stateJson: input.stateJson,
				waitJson: input.waitJson,
				blockedTaskId: input.blockedTaskId,
				blockedSummary: input.blockedSummary,
				updatedAt: input.updatedAt
			}));
		},
		resume: (input) => {
			const flow = resolveManagedFlowForOwner({
				flowId: input.flowId,
				ownerKey
			});
			if (!flow.ok) return {
				applied: false,
				code: flow.code,
				...flow.current ? { current: flow.current } : {}
			};
			return mapFlowUpdateResult(resumeFlow({
				flowId: flow.flow.flowId,
				expectedRevision: input.expectedRevision,
				status: input.status,
				currentStep: input.currentStep,
				stateJson: input.stateJson,
				updatedAt: input.updatedAt
			}));
		},
		finish: (input) => {
			const flow = resolveManagedFlowForOwner({
				flowId: input.flowId,
				ownerKey
			});
			if (!flow.ok) return {
				applied: false,
				code: flow.code,
				...flow.current ? { current: flow.current } : {}
			};
			return mapFlowUpdateResult(finishFlow({
				flowId: flow.flow.flowId,
				expectedRevision: input.expectedRevision,
				stateJson: input.stateJson,
				updatedAt: input.updatedAt,
				endedAt: input.endedAt
			}));
		},
		fail: (input) => {
			const flow = resolveManagedFlowForOwner({
				flowId: input.flowId,
				ownerKey
			});
			if (!flow.ok) return {
				applied: false,
				code: flow.code,
				...flow.current ? { current: flow.current } : {}
			};
			return mapFlowUpdateResult(failFlow({
				flowId: flow.flow.flowId,
				expectedRevision: input.expectedRevision,
				stateJson: input.stateJson,
				blockedTaskId: input.blockedTaskId,
				blockedSummary: input.blockedSummary,
				updatedAt: input.updatedAt,
				endedAt: input.endedAt
			}));
		},
		requestCancel: (input) => {
			const flow = resolveManagedFlowForOwner({
				flowId: input.flowId,
				ownerKey
			});
			if (!flow.ok) return {
				applied: false,
				code: flow.code,
				...flow.current ? { current: flow.current } : {}
			};
			return mapFlowUpdateResult(requestFlowCancel({
				flowId: flow.flow.flowId,
				expectedRevision: input.expectedRevision,
				cancelRequestedAt: input.cancelRequestedAt
			}));
		},
		cancel: ({ flowId, cfg }) => cancelFlowByIdForOwner({
			cfg,
			flowId,
			callerOwnerKey: ownerKey
		}),
		runTask: (input) => {
			const created = runTaskInFlowForOwner({
				flowId: input.flowId,
				callerOwnerKey: ownerKey,
				runtime: input.runtime,
				sourceId: input.sourceId,
				childSessionKey: input.childSessionKey,
				parentTaskId: input.parentTaskId,
				agentId: input.agentId,
				runId: input.runId,
				label: input.label,
				task: input.task,
				preferMetadata: input.preferMetadata,
				notifyPolicy: input.notifyPolicy,
				deliveryStatus: input.deliveryStatus,
				status: input.status,
				startedAt: input.startedAt,
				lastEventAt: input.lastEventAt,
				progressSummary: input.progressSummary
			});
			if (!created.created) return {
				created: false,
				found: created.found,
				reason: created.reason ?? "Task was not created.",
				...created.flow ? { flow: created.flow } : {}
			};
			const managed = asManagedTaskFlowRecord(created.flow);
			if (!managed) return {
				created: false,
				found: true,
				reason: "TaskFlow does not accept managed child tasks.",
				flow: created.flow
			};
			if (!created.task) return {
				created: false,
				found: true,
				reason: "Task was not created.",
				flow: created.flow
			};
			return {
				created: true,
				flow: managed,
				task: created.task
			};
		}
	};
}
function createRuntimeTaskFlow() {
	return {
		bindSession: (params) => createBoundTaskFlowRuntime({
			sessionKey: params.sessionKey,
			requesterOrigin: params.requesterOrigin
		}),
		fromToolContext: (ctx) => createBoundTaskFlowRuntime({
			sessionKey: assertSessionKey(ctx.sessionKey, "TaskFlow runtime requires tool context with a sessionKey."),
			requesterOrigin: ctx.deliveryContext
		})
	};
}
//#endregion
export { createRuntimeTaskFlow as t };
