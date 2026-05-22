import type { Stats } from "node:fs";
import { type ArchiveLogger } from "./archive.js";
type ExistingInstallPathResult = {
    ok: true;
    resolvedPath: string;
    stat: Stats;
} | {
    ok: false;
    error: string;
};
export declare function resolveExistingInstallPath(inputPath: string): Promise<ExistingInstallPathResult>;
export declare function withExtractedArchiveRoot<TResult extends {
    ok: boolean;
}>(params: {
    archivePath: string;
    tempDirPrefix: string;
    timeoutMs: number;
    logger?: ArchiveLogger;
    rootMarkers?: string[];
    onExtracted: (rootDir: string) => Promise<TResult>;
}): Promise<TResult | {
    ok: false;
    error: string;
}>;
export {};
