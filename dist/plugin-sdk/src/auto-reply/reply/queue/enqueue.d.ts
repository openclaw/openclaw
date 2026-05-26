import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";
export declare function enqueueFollowupRun(key: string, run: FollowupRun, settings: QueueSettings, dedupeMode?: QueueDedupeMode, runFollowup?: (run: FollowupRun) => Promise<void>, restartIfIdle?: boolean): boolean;
export declare function getFollowupQueueDepth(key: string): number;
export declare function resetRecentQueuedMessageIdDedupe(): void;
