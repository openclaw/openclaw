type RelativePathOptions = {
    allowRoot?: boolean;
    cwd?: string;
    boundaryLabel?: string;
    includeRootInError?: boolean;
};
export declare function toRelativeWorkspacePath(root: string, candidate: string, options?: Pick<RelativePathOptions, "allowRoot" | "cwd">): string;
export declare function toRelativeSandboxPath(root: string, candidate: string, options?: Pick<RelativePathOptions, "allowRoot" | "cwd">): string;
export declare function resolvePathFromInput(filePath: string, cwd: string): string;
export {};
