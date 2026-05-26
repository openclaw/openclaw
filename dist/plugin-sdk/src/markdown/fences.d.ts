export type FenceSpan = {
    start: number;
    end: number;
    openLine: string;
    marker: string;
    indent: string;
};
export declare function parseFenceSpans(buffer: string): FenceSpan[];
export declare function findFenceSpanAt(spans: FenceSpan[], index: number): FenceSpan | undefined;
export declare function isSafeFenceBreak(spans: FenceSpan[], index: number): boolean;
