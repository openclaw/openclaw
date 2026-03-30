import type { QueueSettings } from "./queue.js";
export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";
export declare function resolveActiveRunQueueAction(params: {
    isActive: boolean;
    isHeartbeat: boolean;
    shouldFollowup: boolean;
    queueMode: QueueSettings["mode"];
}): ActiveRunQueueAction;
