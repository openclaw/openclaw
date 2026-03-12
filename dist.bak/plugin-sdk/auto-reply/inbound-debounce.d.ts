import type { OpenClawConfig } from "../config/config.js";
export declare function resolveInboundDebounceMs(params: {
    cfg: OpenClawConfig;
    channel: string;
    overrideMs?: number;
}): number;
export declare function createInboundDebouncer<T>(params: {
    debounceMs: number;
    buildKey: (item: T) => string | null | undefined;
    shouldDebounce?: (item: T) => boolean;
    resolveDebounceMs?: (item: T) => number | undefined;
    onFlush: (items: T[]) => Promise<void>;
    onError?: (err: unknown, items: T[]) => void;
}): {
    enqueue: (item: T) => Promise<void>;
    flushKey: (key: string) => Promise<void>;
};
