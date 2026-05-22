import { type QueuedSessionDelivery } from "./session-delivery-queue-storage.js";
type SessionDeliveryRecoverySummary = {
    recovered: number;
    failed: number;
    skippedMaxRetries: number;
    deferredBackoff: number;
};
type DeliverSessionDeliveryFn = (entry: QueuedSessionDelivery) => Promise<void>;
export interface SessionDeliveryRecoveryLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}
interface PendingSessionDeliveryDrainDecision {
    match: boolean;
    bypassBackoff?: boolean;
}
export declare function isSessionDeliveryEligibleForRetry(entry: QueuedSessionDelivery, now: number): {
    eligible: true;
} | {
    eligible: false;
    remainingBackoffMs: number;
};
export declare function drainPendingSessionDeliveries(opts: {
    drainKey: string;
    logLabel: string;
    log: SessionDeliveryRecoveryLogger;
    stateDir?: string;
    deliver: DeliverSessionDeliveryFn;
    selectEntry: (entry: QueuedSessionDelivery, now: number) => PendingSessionDeliveryDrainDecision;
}): Promise<void>;
export declare function recoverPendingSessionDeliveries(opts: {
    deliver: DeliverSessionDeliveryFn;
    log: SessionDeliveryRecoveryLogger;
    stateDir?: string;
    maxRecoveryMs?: number;
    maxEnqueuedAt?: number;
}): Promise<SessionDeliveryRecoverySummary>;
export {};
