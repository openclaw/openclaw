export declare const HEARTBEAT_PROMPT = "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
export declare const DEFAULT_HEARTBEAT_EVERY = "30m";
export declare const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;
/**
 * Check if HEARTBEAT.md content is "effectively empty" - meaning it has no actionable tasks.
 * This allows skipping heartbeat API calls when no tasks are configured.
 *
 * A file is considered effectively empty if it contains only:
 * - Whitespace
 * - Comment lines (lines starting with #)
 * - Empty lines
 *
 * Note: A missing file returns false (not effectively empty) so the LLM can still
 * decide what to do. This function is only for when the file exists but has no content.
 */
export declare function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean;
export declare function resolveHeartbeatPrompt(raw?: string): string;
export type StripHeartbeatMode = "heartbeat" | "message";
export declare function stripHeartbeatToken(raw?: string, opts?: {
    mode?: StripHeartbeatMode;
    maxAckChars?: number;
}): {
    shouldSkip: boolean;
    text: string;
    didStrip: boolean;
};
