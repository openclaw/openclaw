export declare const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";
export declare const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";
export declare function resolveCanonicalRootMemoryPath(workspaceDir: string): string;
export declare function resolveLegacyRootMemoryPath(workspaceDir: string): string;
export declare function resolveRootMemoryRepairDir(workspaceDir: string): string;
export declare function exactWorkspaceEntryExists(dir: string, name: string): Promise<boolean>;
export declare function resolveCanonicalRootMemoryFile(workspaceDir: string): Promise<string | null>;
export declare function shouldSkipRootMemoryAuxiliaryPath(params: {
    workspaceDir: string;
    absPath: string;
}): boolean;
