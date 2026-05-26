import type { RuntimeEnv } from "../../runtime.js";
export type StallWatchdogTimeoutMeta = {
    idleMs: number;
    timeoutMs: number;
};
export type ArmableStallWatchdog = {
    arm: (atMs?: number) => void;
    touch: (atMs?: number) => void;
    disarm: () => void;
    stop: () => void;
    isArmed: () => boolean;
};
export declare function createArmableStallWatchdog(params: {
    label: string;
    timeoutMs: number;
    checkIntervalMs?: number;
    abortSignal?: AbortSignal;
    runtime?: RuntimeEnv;
    onTimeout: (meta: StallWatchdogTimeoutMeta) => void;
}): ArmableStallWatchdog;
