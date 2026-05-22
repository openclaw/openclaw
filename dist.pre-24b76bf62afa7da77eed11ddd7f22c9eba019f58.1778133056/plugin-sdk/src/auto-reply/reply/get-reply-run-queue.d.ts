import type { ReplyPayload } from "../types.js";
import type { ActiveRunQueueAction } from "./queue-policy.js";
import type { QueueSettings } from "./queue.js";
export type ReplyRunQueueBusyState = {
    activeSessionId: string | undefined;
    isActive: boolean;
    isStreaming: boolean;
};
export declare function resolvePreparedReplyQueueState(params: {
    activeRunQueueAction: ActiveRunQueueAction;
    activeSessionId: string | undefined;
    queueMode: QueueSettings["mode"];
    sessionKey: string | undefined;
    sessionId: string;
    abortActiveRun: (sessionId: string) => boolean;
    waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
    refreshPreparedState: () => Promise<void>;
    resolveBusyState: () => ReplyRunQueueBusyState;
}): Promise<{
    kind: "continue";
    busyState: ReplyRunQueueBusyState;
} | {
    kind: "reply";
    reply: ReplyPayload;
}>;
