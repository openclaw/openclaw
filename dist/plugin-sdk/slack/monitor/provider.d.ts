import { resolveOpenProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy } from "../../config/runtime-group-policy.js";
import { getSocketEmitter, waitForSlackSocketDisconnect } from "./reconnect-policy.js";
import type { MonitorSlackOpts } from "./types.js";
export declare function monitorSlackProvider(opts?: MonitorSlackOpts): Promise<void>;
export { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";
export declare const __testing: {
    resolveSlackRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
    resolveDefaultGroupPolicy: typeof resolveDefaultGroupPolicy;
    getSocketEmitter: typeof getSocketEmitter;
    waitForSlackSocketDisconnect: typeof waitForSlackSocketDisconnect;
};
