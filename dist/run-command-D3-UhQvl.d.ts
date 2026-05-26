//#region src/plugin-sdk/run-command.d.ts
type PluginCommandRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};
type PluginCommandRunOptions = {
  argv: string[];
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
/** Run a plugin-managed command with timeout handling and normalized stdout/stderr results. */
declare function runPluginCommandWithTimeout(options: PluginCommandRunOptions): Promise<PluginCommandRunResult>;
//#endregion
export { PluginCommandRunResult as n, runPluginCommandWithTimeout as r, PluginCommandRunOptions as t };