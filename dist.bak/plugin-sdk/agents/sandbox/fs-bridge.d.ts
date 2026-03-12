import type { SandboxContext } from "./types.js";
export type SandboxResolvedPath = {
    hostPath: string;
    relativePath: string;
    containerPath: string;
};
export type SandboxFsStat = {
    type: "file" | "directory" | "other";
    size: number;
    mtimeMs: number;
};
export type SandboxFsBridge = {
    resolvePath(params: {
        filePath: string;
        cwd?: string;
    }): SandboxResolvedPath;
    readFile(params: {
        filePath: string;
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<Buffer>;
    writeFile(params: {
        filePath: string;
        cwd?: string;
        data: Buffer | string;
        encoding?: BufferEncoding;
        mkdir?: boolean;
        signal?: AbortSignal;
    }): Promise<void>;
    mkdirp(params: {
        filePath: string;
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<void>;
    remove(params: {
        filePath: string;
        cwd?: string;
        recursive?: boolean;
        force?: boolean;
        signal?: AbortSignal;
    }): Promise<void>;
    rename(params: {
        from: string;
        to: string;
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<void>;
    stat(params: {
        filePath: string;
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<SandboxFsStat | null>;
};
export declare function createSandboxFsBridge(params: {
    sandbox: SandboxContext;
}): SandboxFsBridge;
