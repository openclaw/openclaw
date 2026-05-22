import type { WebClient as SlackWebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../../types.js";
import { type SlackMediaResult } from "../media-types.js";
import type { SlackThreadStarter } from "../thread.js";
type SlackResolvedMessageContent = {
    rawBody: string;
    effectiveDirectMedia: SlackMediaResult[] | null;
};
export declare function resolveSlackMessageContent(params: {
    message: SlackMessageEvent;
    isThreadReply: boolean;
    threadStarter: SlackThreadStarter | null;
    isBotMessage: boolean;
    botToken: string;
    client?: SlackWebClient;
    mediaMaxBytes: number;
    resolveUserName?: (userId: string) => Promise<{
        name?: string;
    }>;
    mediaReadIdleTimeoutMs?: number;
    mediaTotalTimeoutMs?: number;
    abortSignal?: AbortSignal;
}): Promise<SlackResolvedMessageContent | null>;
export {};
