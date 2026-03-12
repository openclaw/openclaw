import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";
export declare function enqueueFollowupRun(key: string, run: FollowupRun, settings: QueueSettings, dedupeMode?: QueueDedupeMode): boolean;
export declare function getFollowupQueueDepth(key: string): number;
