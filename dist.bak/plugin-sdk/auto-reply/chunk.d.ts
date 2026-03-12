import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
export type TextChunkProvider = ChannelId | typeof INTERNAL_MESSAGE_CHANNEL;
/**
 * Chunking mode for outbound messages:
 * - "length": Split only when exceeding textChunkLimit (default)
 * - "newline": Prefer breaking on "soft" boundaries. Historically this split on every
 *   newline; now it only breaks on paragraph boundaries (blank lines) unless the text
 *   exceeds the length limit.
 */
export type ChunkMode = "length" | "newline";
export declare function resolveTextChunkLimit(cfg: OpenClawConfig | undefined, provider?: TextChunkProvider, accountId?: string | null, opts?: {
    fallbackLimit?: number;
}): number;
export declare function resolveChunkMode(cfg: OpenClawConfig | undefined, provider?: TextChunkProvider, accountId?: string | null): ChunkMode;
/**
 * Split text on newlines, trimming line whitespace.
 * Blank lines are folded into the next non-empty line as leading "\n" prefixes.
 * Long lines can be split by length (default) or kept intact via splitLongLines:false.
 */
export declare function chunkByNewline(text: string, maxLineLength: number, opts?: {
    splitLongLines?: boolean;
    trimLines?: boolean;
    isSafeBreak?: (index: number) => boolean;
}): string[];
/**
 * Split text into chunks on paragraph boundaries (blank lines), preserving lists and
 * single-newline line wraps inside paragraphs.
 *
 * - Only breaks at paragraph separators ("\n\n" or more, allowing whitespace on blank lines)
 * - Packs multiple paragraphs into a single chunk up to `limit`
 * - Falls back to length-based splitting when a single paragraph exceeds `limit`
 *   (unless `splitLongParagraphs` is disabled)
 */
export declare function chunkByParagraph(text: string, limit: number, opts?: {
    splitLongParagraphs?: boolean;
}): string[];
/**
 * Unified chunking function that dispatches based on mode.
 */
export declare function chunkTextWithMode(text: string, limit: number, mode: ChunkMode): string[];
export declare function chunkMarkdownTextWithMode(text: string, limit: number, mode: ChunkMode): string[];
export declare function chunkText(text: string, limit: number): string[];
export declare function chunkMarkdownText(text: string, limit: number): string[];
