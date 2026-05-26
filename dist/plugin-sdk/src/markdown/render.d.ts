import type { MarkdownIR, MarkdownLinkSpan, MarkdownStyle, MarkdownStyleSpan } from "./ir.js";
export type RenderStyleMarker = {
    open: string | ((span: MarkdownStyleSpan) => string);
    close: string;
};
export type RenderStyleMap = Partial<Record<MarkdownStyle, RenderStyleMarker>>;
export type RenderLink = {
    start: number;
    end: number;
    open: string;
    close: string;
};
export type RenderOptions = {
    styleMarkers: RenderStyleMap;
    escapeText: (text: string) => string;
    buildLink?: (link: MarkdownLinkSpan, text: string) => RenderLink | null;
};
export declare function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string;
