import type { MessagingToolSend } from "./pi-embedded-messaging.types.js";
export declare function sanitizeToolArgs(args: unknown): unknown;
export declare function sanitizeToolResult(result: unknown): unknown;
export declare function extractToolResultText(result: unknown): string | undefined;
export declare function isToolResultMediaTrusted(toolName?: string, result?: unknown): boolean;
export declare function filterToolResultMediaUrls(toolName: string | undefined, mediaUrls: string[], result?: unknown, builtinToolNames?: ReadonlySet<string>): string[];
/**
 * Extract media file paths from a tool result.
 *
 * Strategy (first match wins):
 * 1. Read structured `details.media` attachments from tool details.
 * 2. Parse `MEDIA:` directive tokens from text content blocks.
 * 3. Fall back to `details.path` when image content exists (legacy imageResult).
 *
 * Returns an empty array when no media is found (e.g. Pi SDK `read` tool
 * returns base64 image data but no file path; those need a different delivery
 * path like saving to a temp file).
 */
type ToolResultMediaArtifact = {
    mediaUrls: string[];
    audioAsVoice?: boolean;
    trustedLocalMedia?: boolean;
};
export declare function extractToolResultMediaArtifact(result: unknown): ToolResultMediaArtifact | undefined;
export declare function extractToolResultMediaPaths(result: unknown): string[];
export declare function isToolResultError(result: unknown): boolean;
export declare function isToolResultTimedOut(result: unknown): boolean;
export declare function extractToolErrorMessage(result: unknown): string | undefined;
export declare function extractMessagingToolSend(toolName: string, args: Record<string, unknown>): MessagingToolSend | undefined;
export {};
