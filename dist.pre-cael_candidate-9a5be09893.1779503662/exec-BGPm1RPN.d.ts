//#region src/process/exec.d.ts
declare function shouldSpawnWithShell(params: {
  resolvedCommand: string;
  platform: NodeJS.Platform;
}): boolean;
declare function runExec(command: string, args: string[], opts?: number | {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
}): Promise<{
  stdout: string;
  stderr: string;
}>;
type SpawnResult = {
  pid?: number;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  noOutputTimedOut?: boolean;
};
type CommandOptions = {
  timeoutMs: number;
  cwd?: string;
  input?: string;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
  signal?: AbortSignal;
};
declare function resolveProcessExitCode(params: {
  explicitCode: number | null | undefined;
  childExitCode: number | null | undefined;
  resolvedSignal: NodeJS.Signals | null;
  usesWindowsExitCodeShim: boolean;
  timedOut: boolean;
  noOutputTimedOut: boolean;
  killIssuedByTimeout: boolean;
  killIssuedByAbort?: boolean;
}): number | null;
declare function resolveCommandEnv(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv;
declare function runCommandWithTimeout(argv: string[], optionsOrTimeout: number | CommandOptions): Promise<SpawnResult>;
//#endregion
export { runCommandWithTimeout as a, resolveProcessExitCode as i, SpawnResult as n, runExec as o, resolveCommandEnv as r, shouldSpawnWithShell as s, CommandOptions as t };