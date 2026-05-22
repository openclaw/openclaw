/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports generic :thread: suffixes plus plugin-owned thread/session grammars.
 */
export declare function parseSessionThreadInfo(sessionKey: string | undefined): {
    baseSessionKey: string | undefined;
    threadId: string | undefined;
};
export declare function parseSessionThreadInfoFast(sessionKey: string | undefined): {
    baseSessionKey: string | undefined;
    threadId: string | undefined;
};
