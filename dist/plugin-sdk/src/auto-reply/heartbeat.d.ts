export type HeartbeatTask = {
    name: string;
    interval: string;
    prompt: string;
};
export declare const HEARTBEAT_PROMPT = "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
export declare const HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS = "Use heartbeat_respond to report the wake outcome. Set notify=false when nothing needs the user's attention. Set notify=true with notificationText only when the user should be interrupted.";
export declare const HEARTBEAT_RESPONSE_TOOL_PROMPT = "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. Use heartbeat_respond to report the wake outcome. Set notify=false when nothing needs the user's attention. Set notify=true with notificationText only when the user should be interrupted.";
export declare const HEARTBEAT_TRANSCRIPT_PROMPT = "[OpenClaw heartbeat poll]";
export declare const DEFAULT_HEARTBEAT_EVERY = "30m";
export declare const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;
/**
 * Check if HEARTBEAT.md content is "effectively empty" - meaning it has no actionable tasks.
 * This allows skipping heartbeat API calls when no tasks are configured.
 *
 * A file is considered effectively empty if it contains only:
 * - Whitespace / empty lines
 * - Markdown ATX headers (`#`, `##`, ...)
 * - Markdown fence markers such as ``` or ```markdown
 * - Empty list item stubs (`- `, `- [ ]`, `* `, `+ `)
 *
 * Note: A missing file returns false (not effectively empty) so the LLM can still
 * decide what to do. This function is only for when the file exists but has no content.
 */
export declare function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean;
export declare function resolveHeartbeatPrompt(raw?: string): string;
export declare function resolveHeartbeatPromptForResponseTool(raw?: string): string;
type StripHeartbeatMode = "heartbeat" | "message";
export declare function stripHeartbeatToken(raw?: string, opts?: {
    mode?: StripHeartbeatMode;
    maxAckChars?: number;
}): {
    shouldSkip: boolean;
    text: string;
    didStrip: boolean;
};
/**
 * Parse heartbeat tasks from HEARTBEAT.md content.
 * Supports YAML-like task definitions:
 *
 * tasks:
 *   - name: email-check
 *     interval: 30m
 *     prompt: "Check for urgent unread emails"
 */
export declare function parseHeartbeatTasks(content: string): HeartbeatTask[];
/**
 * Check if a task is due based on its interval and last run time.
 */
export declare function isTaskDue(lastRunMs: number | undefined, interval: string, nowMs: number): boolean;
export {};
