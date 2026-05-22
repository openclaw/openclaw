export declare function isPathInside(basePath: string, candidatePath: string): boolean;
export declare function isPathInsideWithRealpath(basePath: string, candidatePath: string, opts?: {
    requireRealpath?: boolean;
}): boolean;
export declare function extensionUsesSkippedScannerPath(entry: string): boolean;
