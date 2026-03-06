import type { OpenClawConfig } from "../../config/config.js";
/**
 * Marks every session entry in the store whose key contains {@link threadId}
 * as "reset" by setting `updatedAt` to 0.
 *
 * This mirrors how the daily / idle session reset works: zeroing `updatedAt`
 * makes `evaluateSessionFreshness` treat the session as stale on the next
 * inbound message, so the bot starts a fresh conversation without deleting
 * any on-disk transcript history.
 */
export declare function closeDiscordThreadSessions(params: {
    cfg: OpenClawConfig;
    accountId: string;
    threadId: string;
}): Promise<number>;
