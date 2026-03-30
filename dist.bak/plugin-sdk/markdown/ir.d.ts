import type { MarkdownTableMode } from "../config/types.base.js";
export type MarkdownStyle = "bold" | "italic" | "strikethrough" | "code" | "code_block" | "spoiler" | "blockquote";
export type MarkdownStyleSpan = {
    start: number;
    end: number;
    style: MarkdownStyle;
};
export type MarkdownLinkSpan = {
    start: number;
    end: number;
    href: string;
};
export type MarkdownIR = {
    text: string;
    styles: MarkdownStyleSpan[];
    links: MarkdownLinkSpan[];
};
export type MarkdownParseOptions = {
    linkify?: boolean;
    enableSpoilers?: boolean;
    headingStyle?: "none" | "bold";
    blockquotePrefix?: string;
    autolink?: boolean;
    /** How to render tables (off|bullets|code). Default: off. */
    tableMode?: MarkdownTableMode;
};
export declare function markdownToIR(markdown: string, options?: MarkdownParseOptions): MarkdownIR;
export declare function markdownToIRWithMeta(markdown: string, options?: MarkdownParseOptions): {
    ir: MarkdownIR;
    hasTables: boolean;
};
export declare function chunkMarkdownIR(ir: MarkdownIR, limit: number): MarkdownIR[];
