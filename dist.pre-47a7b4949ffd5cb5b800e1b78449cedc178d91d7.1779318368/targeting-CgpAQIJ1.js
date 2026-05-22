import { a as normalizeContinuationTargetKeys, i as normalizeContinuationTargetKey } from "./targeting-pure-DU9HQ1D9.js";
import { a as emitContinuationFanoutSpan } from "./continuation-tracer-1FDA2mGm.js";
import { s as requestHeartbeatNow } from "./heartbeat-wake-sS2lf3LW.js";
import { a as enqueueSystemEvent } from "./system-events-BRDkm48Z.js";
import { r as enqueueSessionDelivery, t as ackSessionDelivery } from "./session-delivery-queue-storage-BcI9PAy-.js";
//#region src/auto-reply/continuation/targeting.ts
function resolveContinuationReturnTargetSessionKeys(params) {
	const defaultSessionKey = normalizeContinuationTargetKey(params.defaultSessionKey);
	const fallback = defaultSessionKey ? [defaultSessionKey] : [];
	if (params.fanoutMode === "tree") {
		const treeKeys = normalizeContinuationTargetKeys(params.treeSessionKeys);
		return treeKeys.length > 0 ? treeKeys : fallback;
	}
	if (params.fanoutMode === "all") {
		const childSessionKey = normalizeContinuationTargetKey(params.childSessionKey);
		const allKeys = normalizeContinuationTargetKeys(params.allSessionKeys).filter((sessionKey) => sessionKey !== childSessionKey);
		return allKeys.length > 0 ? allKeys : fallback;
	}
	const explicitKeys = normalizeContinuationTargetKeys([...params.targetSessionKey ? [params.targetSessionKey] : [], ...params.targetSessionKeys ?? []]);
	return explicitKeys.length > 0 ? explicitKeys : fallback;
}
const defaultContinuationReturnDeliveryDeps = {
	enqueueSessionDelivery,
	ackSessionDelivery,
	enqueueSystemEvent,
	requestHeartbeatNow
};
async function enqueueContinuationReturnDeliveries(params, deps = defaultContinuationReturnDeliveryDeps) {
	const targetSessionKeys = normalizeContinuationTargetKeys(params.targetSessionKeys);
	const deliveryIds = [];
	let delivered = 0;
	for (const [index, sessionKey] of targetSessionKeys.entries()) {
		const deliveryId = await deps.enqueueSessionDelivery({
			kind: "systemEvent",
			sessionKey,
			text: params.text,
			...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
			...params.traceparent ? { traceparent: params.traceparent } : {},
			idempotencyKey: `${params.idempotencyKeyBase}:${index}:${sessionKey}`
		}, params.stateDir);
		deliveryIds.push(deliveryId);
		deps.enqueueSystemEvent(params.text, {
			sessionKey,
			trusted: true,
			...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
			...params.traceparent ? { traceparent: params.traceparent } : {},
			sessionDeliveryAckId: deliveryId,
			...params.stateDir ? { sessionDeliveryAckStateDir: params.stateDir } : {}
		});
		if (params.wakeRecipients) deps.requestHeartbeatNow({
			sessionKey,
			reason: "delegate-return",
			parentRunId: params.childRunId
		});
		delivered += 1;
	}
	if ((params.traceparent !== void 0 || params.chainStepRemaining !== void 0) && (params.fanoutMode !== void 0 || targetSessionKeys.length > 1)) emitContinuationFanoutSpan({
		targetSessionKeys,
		deliveredCount: delivered,
		...params.fanoutMode ? { fanoutMode: params.fanoutMode } : {},
		...params.chainStepRemaining !== void 0 ? { chainStepRemaining: params.chainStepRemaining } : {},
		...params.traceparent ? { traceparent: params.traceparent } : {}
	});
	return {
		enqueued: deliveryIds.length,
		delivered,
		deliveryIds
	};
}
//#endregion
export { resolveContinuationReturnTargetSessionKeys as n, enqueueContinuationReturnDeliveries as t };
