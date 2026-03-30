import type { OpenClawConfig } from "../config/config.js";
import type { BackoffPolicy } from "../infra/backoff.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
export type ReconnectPolicy = BackoffPolicy & {
    maxAttempts: number;
};
export declare const DEFAULT_HEARTBEAT_SECONDS = 60;
export declare const DEFAULT_RECONNECT_POLICY: ReconnectPolicy;
export declare function resolveHeartbeatSeconds(cfg: OpenClawConfig, overrideSeconds?: number): number;
export declare function resolveReconnectPolicy(cfg: OpenClawConfig, overrides?: Partial<ReconnectPolicy>): ReconnectPolicy;
export { computeBackoff, sleepWithAbort };
export declare function newConnectionId(): `${string}-${string}-${string}-${string}-${string}`;
