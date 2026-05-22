import { type ClearSessionQueueResult } from "./queue.js";
export type ClearSessionResetRuntimeStateResult = ClearSessionQueueResult & {
    systemEventsCleared: number;
};
export declare function clearSessionResetRuntimeState(keys: Array<string | undefined>): ClearSessionResetRuntimeStateResult;
