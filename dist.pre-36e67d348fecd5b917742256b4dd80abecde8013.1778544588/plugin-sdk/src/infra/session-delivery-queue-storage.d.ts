import type { ChatType } from "../channels/chat-type.js";
import type { SessionPostCompactionDelegate } from "../config/sessions/types.js";
import type { InlineAttachment, InlineAttachmentMount } from "../shared/inline-attachments.js";
export declare const DEFAULT_FAILED_MAX_AGE_MS: number;
export declare const DEFAULT_QUEUE_DIR_MAX_FILES = 10000;
export declare class SessionDeliveryQueueOverflowError extends Error {
    readonly kind: "session-delivery-queue-overflow";
    readonly count: number;
    readonly maxFiles: number;
    constructor(count: number, maxFiles: number);
}
export type SessionDeliveryContext = {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
};
export type SessionDeliveryRoute = {
    channel: string;
    to: string;
    accountId?: string;
    replyToId?: string;
    threadId?: string;
    chatType: ChatType;
};
export interface AttachmentRef {
    kind: "blob-sha256";
    sha256: string;
    mediaType?: string;
}
type QueuedSessionDeliveryPayloadMetadata = {
    /**
     * W3C trace-context traceparent for chain-correlation runtime. This is the
     * address-recipient shape; broadcast-mode surfaces use the same substrate
     * with a different verb set.
     */
    traceparent?: string;
    /**
     * Descriptor-stub attachment references for sibling enrichment runtime.
     * This is the address-recipient shape; broadcast mode uses the same substrate
     * with a different verb set.
     */
    attachments?: AttachmentRef[] | InlineAttachment[];
};
export type QueuedSessionDeliveryPayload = ({
    kind: "systemEvent";
    sessionKey: string;
    text: string;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
} | {
    kind: "agentTurn";
    sessionKey: string;
    message: string;
    messageId: string;
    route?: SessionDeliveryRoute;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
} | {
    kind: "postCompactionDelegate";
    sessionKey: string;
    task: string;
    createdAt: number;
    firstArmedAt?: number;
    silent?: boolean;
    silentWake?: boolean;
    targetSessionKey?: string;
    targetSessionKeys?: string[];
    fanoutMode?: "tree" | "all";
    attachments?: InlineAttachment[];
    attachAs?: InlineAttachmentMount;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
}) & QueuedSessionDeliveryPayloadMetadata;
export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
    id: string;
    enqueuedAt: number;
    retryCount: number;
    lastAttemptAt?: number;
    lastError?: string;
};
export declare function buildPostCompactionDelegateDeliveryPayload(params: {
    sessionKey: string;
    delegate: SessionPostCompactionDelegate;
    sequence: number;
    compactionCount?: number;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
}): QueuedSessionDeliveryPayload;
export declare function resolveSessionDeliveryQueueDir(stateDir?: string): string;
export declare function ensureSessionDeliveryQueueDir(stateDir?: string): Promise<string>;
export declare function countQueuedFiles(queueDir: string): Promise<number>;
export declare function enqueueSessionDelivery(params: QueuedSessionDeliveryPayload, stateDir?: string, opts?: {
    maxQueuedFiles?: number;
}): Promise<string>;
export declare function enqueuePostCompactionDelegateDelivery(params: {
    sessionKey: string;
    delegate: SessionPostCompactionDelegate;
    sequence: number;
    compactionCount?: number;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
}, stateDir?: string, opts?: {
    maxQueuedFiles?: number;
}): Promise<string>;
export declare function ackSessionDelivery(id: string, stateDir?: string): Promise<void>;
export declare function failSessionDelivery(id: string, error: string, stateDir?: string): Promise<void>;
export declare function loadPendingSessionDelivery(id: string, stateDir?: string): Promise<QueuedSessionDelivery | null>;
export declare function loadPendingSessionDeliveries(stateDir?: string): Promise<QueuedSessionDelivery[]>;
export declare function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void>;
export declare function pruneFailedOlderThan(maxAgeMs: number, now: number, stateDir?: string): Promise<{
    scanned: number;
    removed: number;
}>;
export {};
