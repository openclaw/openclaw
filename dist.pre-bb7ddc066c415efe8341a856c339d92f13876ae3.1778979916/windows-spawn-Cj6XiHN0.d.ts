//#region src/plugin-sdk/windows-spawn.d.ts
type WindowsSpawnResolution = "direct" | "node-entrypoint" | "exe-entrypoint" | "shell-fallback";
type WindowsSpawnCandidateResolution = Exclude<WindowsSpawnResolution, "shell-fallback">;
type WindowsSpawnProgramCandidate = {
  command: string;
  leadingArgv: string[];
  resolution: WindowsSpawnCandidateResolution | "unresolved-wrapper";
  windowsHide?: boolean;
};
type WindowsSpawnProgram = {
  command: string;
  leadingArgv: string[];
  resolution: WindowsSpawnResolution;
  shell?: boolean;
  windowsHide?: boolean;
};
type WindowsSpawnInvocation = {
  command: string;
  argv: string[];
  resolution: WindowsSpawnResolution;
  shell?: boolean;
  windowsHide?: boolean;
};
type ResolveWindowsSpawnProgramParams = {
  command: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  packageName?: string; /** Trusted compatibility escape hatch for callers that intentionally accept shell-mediated wrapper execution. */
  allowShellFallback?: boolean;
};
type ResolveWindowsSpawnProgramCandidateParams = Omit<ResolveWindowsSpawnProgramParams, "allowShellFallback">;
/** Resolve a Windows command name through PATH and PATHEXT so wrapper inspection sees the real file. */
declare function resolveWindowsExecutablePath(command: string, env: NodeJS.ProcessEnv): string;
/** Resolve the safest direct spawn candidate for Windows wrappers, scripts, and binaries. */
declare function resolveWindowsSpawnProgramCandidate(params: ResolveWindowsSpawnProgramCandidateParams): WindowsSpawnProgramCandidate;
/** Apply shell-fallback policy when Windows wrapper resolution could not find a direct entrypoint. */
declare function applyWindowsSpawnProgramPolicy(params: {
  candidate: WindowsSpawnProgramCandidate;
  allowShellFallback?: boolean;
}): WindowsSpawnProgram;
/** Resolve the final Windows spawn program after candidate discovery and fallback policy. */
declare function resolveWindowsSpawnProgram(params: ResolveWindowsSpawnProgramParams): WindowsSpawnProgram;
/** Combine a resolved Windows spawn program with call-site argv for actual process launch. */
declare function materializeWindowsSpawnProgram(program: WindowsSpawnProgram, argv: string[]): WindowsSpawnInvocation;
//#endregion
export { WindowsSpawnProgram as a, applyWindowsSpawnProgramPolicy as c, resolveWindowsSpawnProgram as d, resolveWindowsSpawnProgramCandidate as f, WindowsSpawnInvocation as i, materializeWindowsSpawnProgram as l, ResolveWindowsSpawnProgramParams as n, WindowsSpawnProgramCandidate as o, WindowsSpawnCandidateResolution as r, WindowsSpawnResolution as s, ResolveWindowsSpawnProgramCandidateParams as t, resolveWindowsExecutablePath as u };