export declare const CONFIG_CLOBBER_SNAPSHOT_LIMIT = 32;
type ConfigClobberSnapshotFs = {
    promises: {
        mkdir(path: string, options?: {
            recursive?: boolean;
            mode?: number;
        }): Promise<unknown>;
        readdir(path: string): Promise<string[]>;
        rmdir(path: string): Promise<unknown>;
        stat(path: string): Promise<{
            mtimeMs?: number;
        } | null>;
        writeFile(path: string, data: string, options?: {
            encoding?: BufferEncoding;
            mode?: number;
            flag?: string;
        }): Promise<unknown>;
    };
    mkdirSync(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): unknown;
    readdirSync(path: string): string[];
    rmdirSync(path: string): unknown;
    statSync(path: string, options?: {
        throwIfNoEntry?: boolean;
    }): {
        mtimeMs?: number;
    } | null;
    writeFileSync(path: string, data: string, options?: {
        encoding?: BufferEncoding;
        mode?: number;
        flag?: string;
    }): unknown;
};
export type ConfigClobberSnapshotDeps = {
    fs: ConfigClobberSnapshotFs;
    logger: Pick<typeof console, "warn">;
};
export declare function persistBoundedClobberedConfigSnapshot(params: {
    deps: ConfigClobberSnapshotDeps;
    configPath: string;
    raw: string;
    observedAt: string;
}): Promise<string | null>;
export declare function persistBoundedClobberedConfigSnapshotSync(params: {
    deps: ConfigClobberSnapshotDeps;
    configPath: string;
    raw: string;
    observedAt: string;
}): string | null;
export {};
