import type { ChatType } from "../channels/chat-type.js";
type SessionDeliveryContext = {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
};
type SessionDeliveryRetryPolicy = {
    maxRetries?: number;
};
export type SessionDeliveryRoute = {
    channel: string;
    to: string;
    accountId?: string;
    replyToId?: string;
    threadId?: string;
    chatType: ChatType;
};
export type QueuedSessionDeliveryPayload = ({
    kind: "systemEvent";
    sessionKey: string;
    text: string;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
} & SessionDeliveryRetryPolicy) | ({
    kind: "agentTurn";
    sessionKey: string;
    message: string;
    messageId: string;
    route?: SessionDeliveryRoute;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
} & SessionDeliveryRetryPolicy);
export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
    id: string;
    enqueuedAt: number;
    retryCount: number;
    lastAttemptAt?: number;
    lastError?: string;
};
export declare function resolveSessionDeliveryQueueDir(stateDir?: string): string;
export declare function enqueueSessionDelivery(params: QueuedSessionDeliveryPayload, stateDir?: string): Promise<string>;
export declare function ackSessionDelivery(id: string, stateDir?: string): Promise<void>;
export declare function failSessionDelivery(id: string, error: string, stateDir?: string): Promise<void>;
export declare function loadPendingSessionDelivery(id: string, stateDir?: string): Promise<QueuedSessionDelivery | null>;
export declare function loadPendingSessionDeliveries(stateDir?: string): Promise<QueuedSessionDelivery[]>;
export declare function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void>;
export {};
