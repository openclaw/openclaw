import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "openclaw/plugin-sdk/runtime-env";
export type ReconnectPolicy = BackoffPolicy & {
    maxAttempts: number;
};
export declare const DEFAULT_HEARTBEAT_SECONDS = 60;
export declare const DEFAULT_RECONNECT_POLICY: ReconnectPolicy;
export declare function resolveHeartbeatSeconds(cfg: OpenClawConfig, overrideSeconds?: number): number;
export declare function resolveReconnectPolicy(cfg: OpenClawConfig, overrides?: Partial<ReconnectPolicy>): ReconnectPolicy;
export { computeBackoff, sleepWithAbort };
export declare function newConnectionId(): `${string}-${string}-${string}-${string}-${string}`;
