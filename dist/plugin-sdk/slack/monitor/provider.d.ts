import { resolveOpenProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy } from "../../config/runtime-group-policy.js";
import { getSocketEmitter, waitForSlackSocketDisconnect } from "./reconnect-policy.js";
import type { MonitorSlackOpts } from "./types.js";
declare function publishSlackConnectedStatus(setStatus?: (next: Record<string, unknown>) => void): void;
declare function publishSlackDisconnectedStatus(setStatus?: (next: Record<string, unknown>) => void, error?: unknown): void;
export declare function monitorSlackProvider(opts?: MonitorSlackOpts): Promise<void>;
export { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";
export declare const __testing: {
    publishSlackConnectedStatus: typeof publishSlackConnectedStatus;
    publishSlackDisconnectedStatus: typeof publishSlackDisconnectedStatus;
    resolveSlackRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
    resolveDefaultGroupPolicy: typeof resolveDefaultGroupPolicy;
    getSocketEmitter: typeof getSocketEmitter;
    waitForSlackSocketDisconnect: typeof waitForSlackSocketDisconnect;
};
