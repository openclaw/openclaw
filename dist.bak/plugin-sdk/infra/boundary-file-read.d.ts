import fs from "node:fs";
import type { PathAliasPolicy } from "./path-alias-guards.js";
import { type SafeOpenSyncFailureReason } from "./safe-open-sync.js";
type BoundaryReadFs = Pick<typeof fs, "closeSync" | "constants" | "fstatSync" | "lstatSync" | "openSync" | "readFileSync" | "realpathSync">;
export type BoundaryFileOpenFailureReason = SafeOpenSyncFailureReason | "validation";
export type BoundaryFileOpenResult = {
    ok: true;
    path: string;
    fd: number;
    stat: fs.Stats;
    rootRealPath: string;
} | {
    ok: false;
    reason: BoundaryFileOpenFailureReason;
    error?: unknown;
};
export type OpenBoundaryFileSyncParams = {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
    rootRealPath?: string;
    maxBytes?: number;
    rejectHardlinks?: boolean;
    skipLexicalRootCheck?: boolean;
    ioFs?: BoundaryReadFs;
};
export type OpenBoundaryFileParams = OpenBoundaryFileSyncParams & {
    aliasPolicy?: PathAliasPolicy;
};
export declare function canUseBoundaryFileOpen(ioFs: typeof fs): boolean;
export declare function openBoundaryFileSync(params: OpenBoundaryFileSyncParams): BoundaryFileOpenResult;
export declare function openBoundaryFile(params: OpenBoundaryFileParams): Promise<BoundaryFileOpenResult>;
export {};
