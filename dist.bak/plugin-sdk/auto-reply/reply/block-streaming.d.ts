import type { OpenClawConfig } from "../../config/config.js";
export type BlockStreamingCoalescing = {
    minChars: number;
    maxChars: number;
    idleMs: number;
    joiner: string;
    /** When true, the coalescer flushes the buffer on each enqueue (paragraph-boundary flush). */
    flushOnEnqueue?: boolean;
};
export type BlockStreamingChunking = {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
};
export declare function resolveEffectiveBlockStreamingConfig(params: {
    cfg: OpenClawConfig | undefined;
    provider?: string;
    accountId?: string | null;
    chunking?: BlockStreamingChunking;
    /** Optional upper bound for chunking/coalescing max chars. */
    maxChunkChars?: number;
    /** Optional coalescer idle flush override in milliseconds. */
    coalesceIdleMs?: number;
}): {
    chunking: BlockStreamingChunking;
    coalescing: BlockStreamingCoalescing;
};
export declare function resolveBlockStreamingChunking(cfg: OpenClawConfig | undefined, provider?: string, accountId?: string | null): BlockStreamingChunking;
export declare function resolveBlockStreamingCoalescing(cfg: OpenClawConfig | undefined, provider?: string, accountId?: string | null, chunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
}, opts?: {
    chunkMode?: "length" | "newline";
}): BlockStreamingCoalescing | undefined;
