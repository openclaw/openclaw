export declare const OPENCLAW_DOCS_URL = "https://docs.openclaw.ai";
export declare const OPENCLAW_SOURCE_URL = "https://github.com/openclaw/openclaw";
type ResolveOpenClawReferencePathParams = {
    workspaceDir?: string;
    argv1?: string;
    cwd?: string;
    moduleUrl?: string;
};
export declare function resolveOpenClawDocsPath(params: {
    workspaceDir?: string;
    argv1?: string;
    cwd?: string;
    moduleUrl?: string;
}): Promise<string | null>;
export declare function resolveOpenClawSourcePath(params: ResolveOpenClawReferencePathParams): Promise<string | null>;
export declare function resolveOpenClawReferencePaths(params: ResolveOpenClawReferencePathParams): Promise<{
    docsPath: string | null;
    sourcePath: string | null;
}>;
export {};
