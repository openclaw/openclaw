export declare const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 120000;
export declare const DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS: number;
export declare function normalizeDiscordListenerTimeoutMs(raw: number | undefined): number;
export declare function normalizeDiscordInboundWorkerTimeoutMs(raw: number | undefined): number | undefined;
export declare function isAbortError(error: unknown): boolean;
export declare function mergeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined;
export declare function runDiscordTaskWithTimeout(params: {
    run: (abortSignal: AbortSignal | undefined) => Promise<void>;
    timeoutMs?: number;
    abortSignals?: Array<AbortSignal | undefined>;
    onTimeout: (timeoutMs: number) => void;
    onAbortAfterTimeout?: () => void;
    onErrorAfterTimeout?: (error: unknown) => void;
}): Promise<boolean>;
