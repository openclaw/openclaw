import type { FollowupRun } from "./types.js";
export declare function clearFollowupDrainCallback(key: string): void;
/** Restart the drain for `key` if it is currently idle, using the stored callback. */
export declare function kickFollowupDrainIfIdle(key: string): void;
export declare function scheduleFollowupDrain(key: string, runFollowup: (run: FollowupRun) => Promise<void>): void;
