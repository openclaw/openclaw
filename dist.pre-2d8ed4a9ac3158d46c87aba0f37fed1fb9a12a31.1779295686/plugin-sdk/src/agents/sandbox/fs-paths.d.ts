import type { SandboxFsBridgeContext } from "./backend-handle.types.js";
export type SandboxFsMount = {
    hostRoot: string;
    containerRoot: string;
    writable: boolean;
    source: "workspace" | "agent" | "bind";
};
export type SandboxResolvedFsPath = {
    hostPath: string;
    relativePath: string;
    containerPath: string;
    writable: boolean;
};
type ParsedBindMount = {
    hostRoot: string;
    containerRoot: string;
    writable: boolean;
};
export declare function parseSandboxBindMount(spec: string): ParsedBindMount | null;
export declare function buildSandboxFsMounts(sandbox: SandboxFsBridgeContext): SandboxFsMount[];
export declare function resolveWritableSandboxBindHostRoots(binds: readonly string[] | undefined): string[];
export declare function hasSandboxBindContainerPathAliases(binds: readonly string[] | undefined): boolean;
export declare function hasSandboxBindReadonlyHostShadows(binds: readonly string[] | undefined): boolean;
export declare function resolveSandboxFsPathWithMounts(params: {
    filePath: string;
    cwd: string;
    defaultWorkspaceRoot: string;
    defaultContainerRoot: string;
    mounts: SandboxFsMount[];
}): SandboxResolvedFsPath;
export {};
