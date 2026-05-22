import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
type SlackMarkdownOptions = {
    tableMode?: MarkdownTableMode;
};
export declare function markdownToSlackMrkdwn(markdown: string, options?: SlackMarkdownOptions): string;
export declare function normalizeSlackOutboundText(markdown: string): string;
export declare function markdownToSlackMrkdwnChunks(markdown: string, limit: number, options?: SlackMarkdownOptions): string[];
export {};
