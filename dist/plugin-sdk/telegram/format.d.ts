import type { MarkdownTableMode } from "../config/types.base.js";
export type TelegramFormattedChunk = {
    html: string;
    text: string;
};
export declare function markdownToTelegramHtml(markdown: string, options?: {
    tableMode?: MarkdownTableMode;
    wrapFileRefs?: boolean;
}): string;
export declare function wrapFileReferencesInHtml(html: string): string;
export declare function renderTelegramHtmlText(text: string, options?: {
    textMode?: "markdown" | "html";
    tableMode?: MarkdownTableMode;
}): string;
export declare function markdownToTelegramChunks(markdown: string, limit: number, options?: {
    tableMode?: MarkdownTableMode;
}): TelegramFormattedChunk[];
export declare function markdownToTelegramHtmlChunks(markdown: string, limit: number): string[];
