import { type MessagingToolSend } from "./pi-embedded-messaging.js";
export declare function sanitizeToolResult(result: unknown): unknown;
export declare function extractToolResultText(result: unknown): string | undefined;
export declare function isToolResultMediaTrusted(toolName?: string): boolean;
export declare function filterToolResultMediaUrls(toolName: string | undefined, mediaUrls: string[]): string[];
/**
 * Extract media file paths from a tool result.
 *
 * Strategy (first match wins):
 * 1. Parse `MEDIA:` tokens from text content blocks (all OpenClaw tools).
 * 2. Fall back to `details.path` when image content exists (OpenClaw imageResult).
 *
 * Returns an empty array when no media is found (e.g. Pi SDK `read` tool
 * returns base64 image data but no file path; those need a different delivery
 * path like saving to a temp file).
 */
export declare function extractToolResultMediaPaths(result: unknown): string[];
export declare function isToolResultError(result: unknown): boolean;
export declare function extractToolErrorMessage(result: unknown): string | undefined;
export declare function extractMessagingToolSend(toolName: string, args: Record<string, unknown>): MessagingToolSend | undefined;
