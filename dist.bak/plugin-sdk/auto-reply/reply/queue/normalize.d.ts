import type { QueueDropPolicy, QueueMode } from "./types.js";
export declare function normalizeQueueMode(raw?: string): QueueMode | undefined;
export declare function normalizeQueueDropPolicy(raw?: string): QueueDropPolicy | undefined;
