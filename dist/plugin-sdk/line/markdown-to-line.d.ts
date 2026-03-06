import type { messagingApi } from "@line/bot-sdk";
import { type FlexBubble } from "./flex-templates.js";
type FlexMessage = messagingApi.FlexMessage;
export interface ProcessedLineMessage {
    /** The processed text with markdown stripped */
    text: string;
    /** Flex messages extracted from tables/code blocks */
    flexMessages: FlexMessage[];
}
/**
 * Detect and extract markdown tables from text
 */
export declare function extractMarkdownTables(text: string): {
    tables: MarkdownTable[];
    textWithoutTables: string;
};
export interface MarkdownTable {
    headers: string[];
    rows: string[][];
}
/**
 * Convert a markdown table to a LINE Flex Message bubble
 */
export declare function convertTableToFlexBubble(table: MarkdownTable): FlexBubble;
/**
 * Detect and extract code blocks from text
 */
export declare function extractCodeBlocks(text: string): {
    codeBlocks: CodeBlock[];
    textWithoutCode: string;
};
export interface CodeBlock {
    language?: string;
    code: string;
}
/**
 * Convert a code block to a LINE Flex Message bubble
 */
export declare function convertCodeBlockToFlexBubble(block: CodeBlock): FlexBubble;
/**
 * Extract markdown links from text
 */
export declare function extractLinks(text: string): {
    links: MarkdownLink[];
    textWithLinks: string;
};
export interface MarkdownLink {
    text: string;
    url: string;
}
/**
 * Create a Flex Message with tappable link buttons
 */
export declare function convertLinksToFlexBubble(links: MarkdownLink[]): FlexBubble;
/**
 * Strip markdown formatting from text (for plain text output)
 * Handles: bold, italic, strikethrough, headers, blockquotes, horizontal rules
 */
export declare function stripMarkdown(text: string): string;
/**
 * Main function: Process text for LINE output
 * - Extracts tables → Flex Messages
 * - Extracts code blocks → Flex Messages
 * - Strips remaining markdown
 * - Returns processed text + Flex Messages
 */
export declare function processLineMessage(text: string): ProcessedLineMessage;
/**
 * Check if text contains markdown that needs conversion
 */
export declare function hasMarkdownToConvert(text: string): boolean;
export {};
