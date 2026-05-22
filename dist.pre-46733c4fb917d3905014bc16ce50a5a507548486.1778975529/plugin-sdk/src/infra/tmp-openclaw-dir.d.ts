export declare const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";
type SecureDirStat = {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode?: number;
    uid?: number;
};
export type ResolvePreferredOpenClawTmpDirOptions = {
    accessSync?: (path: string, mode?: number) => void;
    chmodSync?: (path: string, mode: number) => void;
    getuid?: () => number | undefined;
    lstatSync?: (path: string) => SecureDirStat;
    mkdirSync?: (path: string, opts: {
        recursive: boolean;
        mode?: number;
    }) => void;
    platform?: NodeJS.Platform;
    tmpdir?: () => string;
    warn?: (message: string) => void;
};
export declare function resolvePreferredOpenClawTmpDir(options?: ResolvePreferredOpenClawTmpDirOptions): string;
export {};
