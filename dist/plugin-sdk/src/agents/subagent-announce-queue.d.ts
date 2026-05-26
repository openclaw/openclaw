import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { AgentInternalEvent } from "./internal-events.js";
export type AnnounceQueueItem = {
    announceId?: string;
    prompt: string;
    summaryLine?: string;
    internalEvents?: AgentInternalEvent[];
    enqueuedAt: number;
    sessionKey: string;
    origin?: DeliveryContext;
    originKey?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
};
type AnnounceQueueSettings = {
    mode: QueueMode;
    debounceMs?: number;
    cap?: number;
    dropPolicy?: QueueDropPolicy;
};
export declare function resetAnnounceQueuesForTests(): void;
export declare function enqueueAnnounce(params: {
    key: string;
    item: AnnounceQueueItem;
    settings: AnnounceQueueSettings;
    send: (item: AnnounceQueueItem) => Promise<void>;
    shouldDefer?: (item: AnnounceQueueItem) => boolean;
}): boolean;
export {};
