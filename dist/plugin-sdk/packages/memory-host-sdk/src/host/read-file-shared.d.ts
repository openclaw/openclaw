import type { MemoryReadResult } from "./types.js";
export declare const DEFAULT_MEMORY_READ_LINES = 120;
export declare const DEFAULT_MEMORY_READ_MAX_CHARS = 12000;
export type { MemoryReadResult } from "./types.js";
export declare function buildMemoryReadResultFromSlice(params: {
    selectedLines: string[];
    relPath: string;
    startLine: number;
    moreSourceLinesRemain?: boolean;
    maxChars?: number;
    suggestReadFallback?: boolean;
}): MemoryReadResult;
export declare function buildMemoryReadResult(params: {
    content: string;
    relPath: string;
    from?: number;
    lines?: number;
    defaultLines?: number;
    maxChars?: number;
    suggestReadFallback?: boolean;
}): MemoryReadResult;
