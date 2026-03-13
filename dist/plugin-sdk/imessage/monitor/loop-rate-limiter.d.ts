/**
 * Per-conversation rate limiter that detects rapid-fire identical echo
 * patterns and suppresses them before they amplify into queue overflow.
 */
export type LoopRateLimiter = {
    /** Returns true if this conversation has exceeded the rate limit. */
    isRateLimited: (conversationKey: string) => boolean;
    /** Record an inbound message for a conversation. */
    record: (conversationKey: string) => void;
};
export declare function createLoopRateLimiter(opts?: {
    windowMs?: number;
    maxHits?: number;
}): LoopRateLimiter;
