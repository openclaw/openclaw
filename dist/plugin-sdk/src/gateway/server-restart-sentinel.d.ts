import type { CliDeps } from "../cli/deps.types.js";
import { type RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { type SessionDeliveryRecoveryLogger } from "../infra/session-delivery-queue.js";
export declare function recoverPendingRestartContinuationDeliveries(params: {
    deps: CliDeps;
    log?: SessionDeliveryRecoveryLogger;
    maxEnqueuedAt?: number;
}): Promise<void>;
export declare function scheduleRestartSentinelWake(params: {
    deps: CliDeps;
}): Promise<void>;
export declare function shouldWakeFromRestartSentinel(): boolean;
export declare function refreshLatestUpdateRestartSentinel(): Promise<RestartSentinelPayload | null>;
export declare function getLatestUpdateRestartSentinel(): RestartSentinelPayload | null;
export declare function recordLatestUpdateRestartSentinel(payload: RestartSentinelPayload): void;
