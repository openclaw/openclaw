export type ExtractMode = "markdown" | "text";
export declare function htmlToMarkdown(html: string): {
    text: string;
    title?: string;
};
export declare function markdownToText(markdown: string): string;
export declare function truncateText(value: string, maxChars: number): {
    text: string;
    truncated: boolean;
};
export declare function extractReadableContent(params: {
    html: string;
    url: string;
    extractMode: ExtractMode;
}): Promise<{
    text: string;
    title?: string;
} | null>;
