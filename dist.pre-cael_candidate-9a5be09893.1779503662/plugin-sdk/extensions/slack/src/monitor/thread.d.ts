import type { WebClient as SlackWebClient } from "@slack/web-api";
import type { SlackFile } from "../types.js";
export type SlackThreadStarter = {
    text: string;
    userId?: string;
    botId?: string;
    ts?: string;
    files?: SlackFile[];
};
export declare function resolveSlackThreadStarter(params: {
    channelId: string;
    threadTs: string;
    client: SlackWebClient;
}): Promise<SlackThreadStarter | null>;
export declare function resetSlackThreadStarterCacheForTest(): void;
export type SlackThreadMessage = {
    text: string;
    userId?: string;
    ts?: string;
    botId?: string;
    files?: SlackFile[];
};
/**
 * Fetches the most recent messages in a Slack thread (excluding the current message).
 * Used to populate thread context when a new thread session starts.
 *
 * Uses cursor pagination and keeps only the latest N retained messages so long threads
 * still produce up-to-date context without unbounded memory growth.
 */
export declare function resolveSlackThreadHistory(params: {
    channelId: string;
    threadTs: string;
    client: SlackWebClient;
    currentMessageTs?: string;
    limit?: number;
}): Promise<SlackThreadMessage[]>;
