import { resolveDefaultGroupPolicy, resolveOpenProviderRuntimeGroupPolicy } from "./config.runtime.js";
import { createSlackBoltApp, createSlackSocketDisconnectWaiter, formatSlackChannelResolved, formatSlackUserResolved, gracefulStopSlackApp, publishSlackConnectedStatus, publishSlackDisconnectedStatus, resolveSlackBoltInterop, resolveSlackSocketShutdownClient, startSlackSocketAndWaitForDisconnect } from "./provider-support.js";
import { getSocketEmitter, waitForSlackSocketDisconnect } from "./reconnect-policy.js";
import type { MonitorSlackOpts } from "./types.js";
export declare function formatSlackSocketReconnectMessage(params: {
    event: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error?: unknown;
}): string;
export declare function formatSlackSocketStartRetryMessage(params: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: unknown;
    sdkContext?: string;
}): string;
export declare function monitorSlackProvider(opts?: MonitorSlackOpts): Promise<void>;
export { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";
export declare const resolveSlackRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
export declare const testing: {
    formatSlackChannelResolved: typeof formatSlackChannelResolved;
    formatSlackUserResolved: typeof formatSlackUserResolved;
    publishSlackConnectedStatus: typeof publishSlackConnectedStatus;
    publishSlackDisconnectedStatus: typeof publishSlackDisconnectedStatus;
    resolveSlackSocketShutdownClient: typeof resolveSlackSocketShutdownClient;
    gracefulStopSlackApp: typeof gracefulStopSlackApp;
    resolveSlackRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
    resolveDefaultGroupPolicy: typeof resolveDefaultGroupPolicy;
    resolveSlackBoltInterop: typeof resolveSlackBoltInterop;
    createSlackBoltApp: typeof createSlackBoltApp;
    createSlackSocketDisconnectWaiter: typeof createSlackSocketDisconnectWaiter;
    startSlackSocketAndWaitForDisconnect: typeof startSlackSocketAndWaitForDisconnect;
    getSocketEmitter: typeof getSocketEmitter;
    waitForSlackSocketDisconnect: typeof waitForSlackSocketDisconnect;
};
export { testing as __testing };
