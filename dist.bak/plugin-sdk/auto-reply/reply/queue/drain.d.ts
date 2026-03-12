import type { FollowupRun } from "./types.js";
export declare function scheduleFollowupDrain(key: string, runFollowup: (run: FollowupRun) => Promise<void>): void;
