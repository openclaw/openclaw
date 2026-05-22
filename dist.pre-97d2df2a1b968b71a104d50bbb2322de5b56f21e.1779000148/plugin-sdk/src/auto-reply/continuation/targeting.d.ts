import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { ackSessionDelivery, enqueueSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import type { SessionDeliveryContext } from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { CONTINUATION_DELEGATE_FANOUT_MODES, hasContinuationDelegateTargeting, hasCrossSessionDelegateTargeting, normalizeContinuationTargetKey, normalizeContinuationTargetKeys } from "./targeting-pure.js";
import type { ContinuationCrossSessionTargetingPolicy, ContinuationDelegateFanoutMode, ContinuationDelegateTargeting } from "./targeting-pure.js";
export { CONTINUATION_DELEGATE_FANOUT_MODES, hasContinuationDelegateTargeting, hasCrossSessionDelegateTargeting, normalizeContinuationTargetKey, normalizeContinuationTargetKeys, };
export type { ContinuationCrossSessionTargetingPolicy, ContinuationDelegateFanoutMode, ContinuationDelegateTargeting, };
export declare function resolveContinuationReturnTargetSessionKeys(params: ContinuationDelegateTargeting & {
    defaultSessionKey: string;
    treeSessionKeys?: readonly string[];
    allSessionKeys?: readonly string[];
    childSessionKey?: string;
}): string[];
type ContinuationReturnDeliveryDeps = {
    enqueueSessionDelivery: typeof enqueueSessionDelivery;
    ackSessionDelivery: typeof ackSessionDelivery;
    enqueueSystemEvent: typeof enqueueSystemEvent;
    requestHeartbeatNow: typeof requestHeartbeatNow;
};
export declare function enqueueContinuationReturnDeliveries(params: {
    targetSessionKeys: readonly string[];
    text: string;
    idempotencyKeyBase: string;
    deliveryContext?: SessionDeliveryContext;
    wakeRecipients?: boolean;
    childRunId?: string;
    stateDir?: string;
    traceparent?: string;
    fanoutMode?: ContinuationDelegateFanoutMode;
    chainStepRemaining?: number;
}, deps?: ContinuationReturnDeliveryDeps): Promise<{
    enqueued: number;
    delivered: number;
    deliveryIds: string[];
}>;
