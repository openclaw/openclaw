export declare const MAX_SAFE_TIMEOUT_DELAY_MS = 2147483647;
export declare function resolveSafeTimeoutDelayMs(delayMs: number, opts?: {
    minMs?: number;
}): number;
export declare function setSafeTimeout(callback: () => void, delayMs: number, opts?: {
    minMs?: number;
}): NodeJS.Timeout;
