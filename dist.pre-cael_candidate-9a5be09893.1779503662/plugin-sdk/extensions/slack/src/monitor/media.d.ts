import type { WebClient as SlackWebClient } from "@slack/web-api";
import type { SlackAttachment, SlackFile } from "../types.js";
export { MAX_SLACK_MEDIA_FILES, type SlackMediaResult } from "./media-types.js";
import { type SlackMediaResult } from "./media-types.js";
export { resetSlackThreadStarterCacheForTest, resolveSlackThreadHistory, resolveSlackThreadStarter, type SlackThreadMessage, type SlackThreadStarter, } from "./thread.js";
/**
 * Fetches a URL with Authorization header while keeping same-origin redirects
 * authenticated and dropping auth once the redirect crosses origins.
 */
export declare function fetchWithSlackAuth(url: string, token: string): Promise<Response>;
export declare const SLACK_MEDIA_READ_IDLE_TIMEOUT_MS = 60000;
export declare const SLACK_MEDIA_TOTAL_TIMEOUT_MS = 120000;
/**
 * Downloads all files attached to a Slack message and returns them as an array.
 * Returns `null` when no files could be downloaded.
 */
export declare function resolveSlackMedia(params: {
    files?: SlackFile[];
    client?: SlackWebClient;
    token: string;
    maxBytes: number;
    readIdleTimeoutMs?: number;
    totalTimeoutMs?: number;
    abortSignal?: AbortSignal;
}): Promise<SlackMediaResult[] | null>;
/** Extracts text and media from forwarded-message attachments. Returns null when empty. */
export declare function resolveSlackAttachmentContent(params: {
    attachments?: SlackAttachment[];
    client?: SlackWebClient;
    token: string;
    maxBytes: number;
    readIdleTimeoutMs?: number;
    totalTimeoutMs?: number;
    abortSignal?: AbortSignal;
}): Promise<{
    text: string;
    media: SlackMediaResult[];
} | null>;
