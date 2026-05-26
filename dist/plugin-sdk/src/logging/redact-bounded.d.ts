type BoundedRedactOptions = {
    chunkThreshold?: number;
    chunkSize?: number;
};
export declare function replacePatternBounded(text: string, pattern: RegExp, replacer: Parameters<string["replace"]>[1], options?: BoundedRedactOptions): string;
export {};
