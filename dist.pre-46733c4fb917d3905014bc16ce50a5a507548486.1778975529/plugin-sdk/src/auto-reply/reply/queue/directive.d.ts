import type { QueueDropPolicy, QueueMode } from "./types.js";
export declare function extractQueueDirective(body?: string): {
    cleaned: string;
    queueMode?: QueueMode;
    queueReset: boolean;
    rawMode?: string;
    hasDirective: boolean;
    debounceMs?: number;
    cap?: number;
    dropPolicy?: QueueDropPolicy;
    rawDebounce?: string;
    rawCap?: string;
    rawDrop?: string;
    hasOptions: boolean;
};
