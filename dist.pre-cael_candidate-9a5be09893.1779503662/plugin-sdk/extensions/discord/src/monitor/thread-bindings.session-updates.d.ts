import type { ThreadBindingRecord } from "./thread-bindings.types.js";
export declare function setThreadBindingIdleTimeoutBySessionKey(params: {
    targetSessionKey: string;
    accountId?: string;
    idleTimeoutMs: number;
}): ThreadBindingRecord[];
export declare function setThreadBindingMaxAgeBySessionKey(params: {
    targetSessionKey: string;
    accountId?: string;
    maxAgeMs: number;
}): ThreadBindingRecord[];
