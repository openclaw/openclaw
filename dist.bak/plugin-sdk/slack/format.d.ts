import type { MarkdownTableMode } from "../config/types.base.js";
type SlackMarkdownOptions = {
    tableMode?: MarkdownTableMode;
};
export declare function markdownToSlackMrkdwn(markdown: string, options?: SlackMarkdownOptions): string;
export declare function markdownToSlackMrkdwnChunks(markdown: string, limit: number, options?: SlackMarkdownOptions): string[];
export {};
