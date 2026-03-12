import type { WebClient as SlackWebClient } from "@slack/web-api";
import type { SlackAttachment, SlackFile } from "../types.js";
/**
 * Fetches a URL with Authorization header, handling cross-origin redirects.
 * Node.js fetch strips Authorization headers on cross-origin redirects for security.
 * Slack's file URLs redirect to CDN domains with pre-signed URLs that don't need the
 * Authorization header, so we handle the initial auth request manually.
 */
export declare function fetchWithSlackAuth(url: string, token: string): Promise<Response>;
export type SlackMediaResult = {
    path: string;
    contentType?: string;
    placeholder: string;
};
export declare const MAX_SLACK_MEDIA_FILES = 8;
/**
 * Downloads all files attached to a Slack message and returns them as an array.
 * Returns `null` when no files could be downloaded.
 */
export declare function resolveSlackMedia(params: {
    files?: SlackFile[];
    token: string;
    maxBytes: number;
}): Promise<SlackMediaResult[] | null>;
/** Extracts text and media from forwarded-message attachments. Returns null when empty. */
export declare function resolveSlackAttachmentContent(params: {
    attachments?: SlackAttachment[];
    token: string;
    maxBytes: number;
}): Promise<{
    text: string;
    media: SlackMediaResult[];
} | null>;
export type SlackThreadStarter = {
    text: string;
    userId?: string;
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
