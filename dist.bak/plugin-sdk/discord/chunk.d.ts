import { type ChunkMode } from "../auto-reply/chunk.js";
export type ChunkDiscordTextOpts = {
    /** Max characters per Discord message. Default: 2000. */
    maxChars?: number;
    /**
     * Soft max line count per message. Default: 17.
     *
     * Discord clients can clip/collapse very tall messages in the UI; splitting
     * by lines keeps long multi-paragraph replies readable.
     */
    maxLines?: number;
};
/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
export declare function chunkDiscordText(text: string, opts?: ChunkDiscordTextOpts): string[];
export declare function chunkDiscordTextWithMode(text: string, opts: ChunkDiscordTextOpts & {
    chunkMode?: ChunkMode;
}): string[];
