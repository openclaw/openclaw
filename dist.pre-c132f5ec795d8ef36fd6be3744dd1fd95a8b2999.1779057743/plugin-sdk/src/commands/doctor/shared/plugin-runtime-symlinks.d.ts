interface FsLike {
    readdir(dir: string, options: {
        withFileTypes: true;
    }): Promise<readonly DirentLike[]>;
    lstat(file: string): Promise<StatsLike>;
    readlink(file: string): Promise<string>;
    stat(file: string): Promise<unknown>;
    rm(file: string, options: {
        force: true;
    }): Promise<void>;
    unlink?(file: string): Promise<void>;
}
interface DirentLike {
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}
interface StatsLike {
    isSymbolicLink(): boolean;
}
export interface StalePluginRuntimeSymlink {
    readonly name: string;
    readonly path: string;
    readonly target: string;
}
export interface PluginRuntimeSymlinkOptions {
    readonly fs?: FsLike;
    readonly staleRoots?: readonly string[];
}
export declare function collectStalePluginRuntimeSymlinks(packageRoot: string | null | undefined, options?: PluginRuntimeSymlinkOptions): Promise<StalePluginRuntimeSymlink[]>;
export declare function noteStalePluginRuntimeSymlinks(packageRoot: string | null | undefined, options?: PluginRuntimeSymlinkOptions & {
    readonly noteFn?: (message: string, title?: string) => void;
    readonly shortenPath?: (value: string) => string;
}): Promise<void>;
export declare function removeStalePluginRuntimeSymlinks(packageRoot: string | null | undefined, options?: PluginRuntimeSymlinkOptions): Promise<{
    changes: string[];
    warnings: string[];
}>;
export {};
