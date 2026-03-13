export type WindowsSpawnResolution = "direct" | "node-entrypoint" | "exe-entrypoint" | "shell-fallback";
export type WindowsSpawnCandidateResolution = Exclude<WindowsSpawnResolution, "shell-fallback">;
export type WindowsSpawnProgramCandidate = {
    command: string;
    leadingArgv: string[];
    resolution: WindowsSpawnCandidateResolution | "unresolved-wrapper";
    windowsHide?: boolean;
};
export type WindowsSpawnProgram = {
    command: string;
    leadingArgv: string[];
    resolution: WindowsSpawnResolution;
    shell?: boolean;
    windowsHide?: boolean;
};
export type WindowsSpawnInvocation = {
    command: string;
    argv: string[];
    resolution: WindowsSpawnResolution;
    shell?: boolean;
    windowsHide?: boolean;
};
export type ResolveWindowsSpawnProgramParams = {
    command: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    packageName?: string;
    allowShellFallback?: boolean;
};
export type ResolveWindowsSpawnProgramCandidateParams = Omit<ResolveWindowsSpawnProgramParams, "allowShellFallback">;
export declare function resolveWindowsExecutablePath(command: string, env: NodeJS.ProcessEnv): string;
export declare function resolveWindowsSpawnProgramCandidate(params: ResolveWindowsSpawnProgramCandidateParams): WindowsSpawnProgramCandidate;
export declare function applyWindowsSpawnProgramPolicy(params: {
    candidate: WindowsSpawnProgramCandidate;
    allowShellFallback?: boolean;
}): WindowsSpawnProgram;
export declare function resolveWindowsSpawnProgram(params: ResolveWindowsSpawnProgramParams): WindowsSpawnProgram;
export declare function materializeWindowsSpawnProgram(program: WindowsSpawnProgram, argv: string[]): WindowsSpawnInvocation;
