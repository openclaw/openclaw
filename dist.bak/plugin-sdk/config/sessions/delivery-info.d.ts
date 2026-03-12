/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports both :thread: (most channels) and :topic: (Telegram).
 */
export declare function parseSessionThreadInfo(sessionKey: string | undefined): {
    baseSessionKey: string | undefined;
    threadId: string | undefined;
};
export declare function extractDeliveryInfo(sessionKey: string | undefined): {
    deliveryContext: {
        channel?: string;
        to?: string;
        accountId?: string;
    } | undefined;
    threadId: string | undefined;
};
