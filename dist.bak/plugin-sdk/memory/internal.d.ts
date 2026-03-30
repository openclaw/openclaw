export type MemoryFileEntry = {
    path: string;
    absPath: string;
    mtimeMs: number;
    size: number;
    hash: string;
};
export type MemoryChunk = {
    startLine: number;
    endLine: number;
    text: string;
    hash: string;
};
export declare function ensureDir(dir: string): string;
export declare function normalizeRelPath(value: string): string;
export declare function normalizeExtraMemoryPaths(workspaceDir: string, extraPaths?: string[]): string[];
export declare function isMemoryPath(relPath: string): boolean;
export declare function listMemoryFiles(workspaceDir: string, extraPaths?: string[]): Promise<string[]>;
export declare function hashText(value: string): string;
export declare function buildFileEntry(absPath: string, workspaceDir: string): Promise<MemoryFileEntry | null>;
export declare function chunkMarkdown(content: string, chunking: {
    tokens: number;
    overlap: number;
}): MemoryChunk[];
/**
 * Remap chunk startLine/endLine from content-relative positions to original
 * source file positions using a lineMap.  Each entry in lineMap gives the
 * 1-indexed source line for the corresponding 0-indexed content line.
 *
 * This is used for session JSONL files where buildSessionEntry() flattens
 * messages into a plain-text string before chunking.  Without remapping the
 * stored line numbers would reference positions in the flattened text rather
 * than the original JSONL file.
 */
export declare function remapChunkLines(chunks: MemoryChunk[], lineMap: number[] | undefined): void;
export declare function parseEmbedding(raw: string): number[];
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]>;
