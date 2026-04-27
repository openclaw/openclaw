import type { PathAliasPolicy } from "../../infra/path-alias-guards.js";
import type { SafeOpenSyncAllowedType } from "../../infra/safe-open-sync.js";
import { type BoundaryFileOpenResult } from "./fs-bridge-path-safety.runtime.js";
import type { SandboxResolvedFsPath, SandboxFsMount } from "./fs-paths.js";
export type PathSafetyOptions = {
    action: string;
    aliasPolicy?: PathAliasPolicy;
    requireWritable?: boolean;
    allowedType?: SafeOpenSyncAllowedType;
};
export type PathSafetyCheck = {
    target: SandboxResolvedFsPath;
    options: PathSafetyOptions;
};
export type PinnedSandboxEntry = {
    mountRootPath: string;
    relativeParentPath: string;
    basename: string;
};
export type AnchoredSandboxEntry = {
    canonicalParentPath: string;
    basename: string;
};
export type PinnedSandboxDirectoryEntry = {
    mountRootPath: string;
    relativePath: string;
};
type RunCommand = (script: string, options?: {
    args?: string[];
    stdin?: Buffer | string;
    allowFailure?: boolean;
    signal?: AbortSignal;
}) => Promise<{
    stdout: Buffer;
}>;
export declare class SandboxFsPathGuard {
    private readonly mountsByContainer;
    private readonly runCommand;
    constructor(params: {
        mountsByContainer: SandboxFsMount[];
        runCommand: RunCommand;
    });
    assertPathChecks(checks: PathSafetyCheck[]): Promise<void>;
    assertPathSafety(target: SandboxResolvedFsPath, options: PathSafetyOptions): Promise<void>;
    openReadableFile(target: SandboxResolvedFsPath): Promise<BoundaryFileOpenResult & {
        ok: true;
    }>;
    private resolveRequiredMount;
    private finalizePinnedEntry;
    private assertGuardedPathSafety;
    private openBoundaryWithinRequiredMount;
    resolvePinnedEntry(target: SandboxResolvedFsPath, action: string): PinnedSandboxEntry;
    resolveAnchoredSandboxEntry(target: SandboxResolvedFsPath, action: string): Promise<AnchoredSandboxEntry>;
    resolveAnchoredPinnedEntry(target: SandboxResolvedFsPath, action: string): Promise<PinnedSandboxEntry>;
    resolvePinnedDirectoryEntry(target: SandboxResolvedFsPath, action: string): PinnedSandboxDirectoryEntry;
    private pathIsExistingDirectory;
    private resolveMountByContainerPath;
    private resolveCanonicalContainerPath;
}
export {};
