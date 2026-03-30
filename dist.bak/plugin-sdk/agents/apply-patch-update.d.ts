type UpdateFileChunk = {
    changeContext?: string;
    oldLines: string[];
    newLines: string[];
    isEndOfFile: boolean;
};
export declare function applyUpdateHunk(filePath: string, chunks: UpdateFileChunk[], options?: {
    readFile?: (filePath: string) => Promise<string>;
}): Promise<string>;
export {};
