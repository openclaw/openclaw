export declare function installPackageDir(params: {
    sourceDir: string;
    targetDir: string;
    mode: "install" | "update";
    timeoutMs: number;
    logger?: {
        info?: (message: string) => void;
        warn?: (message: string) => void;
    };
    copyErrorPrefix: string;
    hasDeps: boolean;
    depsLogMessage: string;
    afterCopy?: (installedDir: string) => void | Promise<void>;
    afterInstall?: (installedDir: string) => Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
        code?: string;
    }>;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
    code?: string;
}>;
export declare function installPackageDirWithManifestDeps(params: {
    sourceDir: string;
    targetDir: string;
    mode: "install" | "update";
    timeoutMs: number;
    logger?: {
        info?: (message: string) => void;
        warn?: (message: string) => void;
    };
    copyErrorPrefix: string;
    depsLogMessage: string;
    manifestDependencies?: Record<string, unknown>;
    afterCopy?: (installedDir: string) => void | Promise<void>;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
