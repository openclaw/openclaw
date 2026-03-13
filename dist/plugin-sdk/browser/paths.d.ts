export declare const DEFAULT_BROWSER_TMP_DIR: string;
export declare const DEFAULT_TRACE_DIR: string;
export declare const DEFAULT_DOWNLOAD_DIR: string;
export declare const DEFAULT_UPLOAD_DIR: string;
export declare function resolvePathWithinRoot(params: {
    rootDir: string;
    requestedPath: string;
    scopeLabel: string;
    defaultFileName?: string;
}): {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
};
export declare function resolveWritablePathWithinRoot(params: {
    rootDir: string;
    requestedPath: string;
    scopeLabel: string;
    defaultFileName?: string;
}): Promise<{
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
}>;
export declare function resolvePathsWithinRoot(params: {
    rootDir: string;
    requestedPaths: string[];
    scopeLabel: string;
}): {
    ok: true;
    paths: string[];
} | {
    ok: false;
    error: string;
};
export declare function resolveExistingPathsWithinRoot(params: {
    rootDir: string;
    requestedPaths: string[];
    scopeLabel: string;
}): Promise<{
    ok: true;
    paths: string[];
} | {
    ok: false;
    error: string;
}>;
export declare function resolveStrictExistingPathsWithinRoot(params: {
    rootDir: string;
    requestedPaths: string[];
    scopeLabel: string;
}): Promise<{
    ok: true;
    paths: string[];
} | {
    ok: false;
    error: string;
}>;
