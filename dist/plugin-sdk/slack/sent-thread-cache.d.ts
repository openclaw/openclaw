/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
 */
export declare function recordSlackThreadParticipation(accountId: string, channelId: string, threadTs: string): void;
export declare function hasSlackThreadParticipation(accountId: string, channelId: string, threadTs: string): boolean;
export declare function clearSlackThreadParticipationCache(): void;
