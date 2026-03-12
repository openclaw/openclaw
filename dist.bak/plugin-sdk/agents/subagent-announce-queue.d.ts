import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { type DeliveryContext } from "../utils/delivery-context.js";
export type AnnounceQueueItem = {
    announceId?: string;
    prompt: string;
    summaryLine?: string;
    enqueuedAt: number;
    sessionKey: string;
    origin?: DeliveryContext;
    originKey?: string;
};
export type AnnounceQueueSettings = {
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
}): boolean;
