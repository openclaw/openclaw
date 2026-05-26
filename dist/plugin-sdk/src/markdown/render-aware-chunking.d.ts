import { type MarkdownIR } from "./ir.js";
export type RenderedMarkdownChunk<TRendered> = {
    rendered: TRendered;
    source: MarkdownIR;
};
export type RenderMarkdownIRChunksWithinLimitOptions<TRendered> = {
    ir: MarkdownIR;
    limit: number;
    measureRendered: (rendered: TRendered) => number;
    renderChunk: (ir: MarkdownIR) => TRendered;
};
export declare function renderMarkdownIRChunksWithinLimit<TRendered>(options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>): RenderedMarkdownChunk<TRendered>[];
