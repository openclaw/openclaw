import fs from "node:fs";
export type SafeOpenSyncFailureReason = "path" | "validation" | "io";
export type SafeOpenSyncResult = {
    ok: true;
    path: string;
    fd: number;
    stat: fs.Stats;
} | {
    ok: false;
    reason: SafeOpenSyncFailureReason;
    error?: unknown;
};
type SafeOpenSyncFs = Pick<typeof fs, "constants" | "lstatSync" | "realpathSync" | "openSync" | "fstatSync" | "closeSync">;
export declare function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean;
export declare function openVerifiedFileSync(params: {
    filePath: string;
    resolvedPath?: string;
    rejectPathSymlink?: boolean;
    rejectHardlinks?: boolean;
    maxBytes?: number;
    ioFs?: SafeOpenSyncFs;
}): SafeOpenSyncResult;
export {};
