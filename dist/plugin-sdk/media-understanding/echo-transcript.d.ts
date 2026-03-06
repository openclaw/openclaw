import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
export declare const DEFAULT_ECHO_TRANSCRIPT_FORMAT = "\uD83D\uDCDD \"{transcript}\"";
/**
 * Sends the transcript echo back to the originating chat.
 * Best-effort: logs on failure, never throws.
 */
export declare function sendTranscriptEcho(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    transcript: string;
    format?: string;
}): Promise<void>;
