import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OutboundChannel } from "./targets.js";
declare const MAX_RETRIES = 5;
type DeliveryMirrorPayload = {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
};
type QueuedDeliveryPayload = {
    channel: Exclude<OutboundChannel, "none">;
    to: string;
    accountId?: string;
    /**
     * Original payloads before plugin hooks. On recovery, hooks re-run on these
     * payloads — this is intentional since hooks are stateless transforms and
     * should produce the same result on replay.
     */
    payloads: ReplyPayload[];
    threadId?: string | number | null;
    replyToId?: string | null;
    bestEffort?: boolean;
    gifPlayback?: boolean;
    silent?: boolean;
    mirror?: DeliveryMirrorPayload;
};
export interface QueuedDelivery extends QueuedDeliveryPayload {
    id: string;
    enqueuedAt: number;
    retryCount: number;
    lastAttemptAt?: number;
    lastError?: string;
}
export type RecoverySummary = {
    recovered: number;
    failed: number;
    skippedMaxRetries: number;
    deferredBackoff: number;
};
/** Ensure the queue directory (and failed/ subdirectory) exist. */
export declare function ensureQueueDir(stateDir?: string): Promise<string>;
/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
type QueuedDeliveryParams = QueuedDeliveryPayload;
export declare function enqueueDelivery(params: QueuedDeliveryParams, stateDir?: string): Promise<string>;
/** Remove a successfully delivered entry from the queue. */
export declare function ackDelivery(id: string, stateDir?: string): Promise<void>;
/** Update a queue entry after a failed delivery attempt. */
export declare function failDelivery(id: string, error: string, stateDir?: string): Promise<void>;
/** Load all pending delivery entries from the queue directory. */
export declare function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]>;
/** Move a queue entry to the failed/ subdirectory. */
export declare function moveToFailed(id: string, stateDir?: string): Promise<void>;
/** Compute the backoff delay in ms for a given retry count. */
export declare function computeBackoffMs(retryCount: number): number;
export declare function isEntryEligibleForRecoveryRetry(entry: QueuedDelivery, now: number): {
    eligible: true;
} | {
    eligible: false;
    remainingBackoffMs: number;
};
export type DeliverFn = (params: {
    cfg: OpenClawConfig;
} & QueuedDeliveryParams & {
    skipQueue?: boolean;
}) => Promise<unknown>;
export interface RecoveryLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}
/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
 */
export declare function recoverPendingDeliveries(opts: {
    deliver: DeliverFn;
    log: RecoveryLogger;
    cfg: OpenClawConfig;
    stateDir?: string;
    /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next restart. Default: 60 000. */
    maxRecoveryMs?: number;
}): Promise<RecoverySummary>;
export { MAX_RETRIES };
export declare function isPermanentDeliveryError(error: string): boolean;
