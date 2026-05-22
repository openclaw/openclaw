export type PluginCommandRunResult = {
    code: number;
    stdout: string;
    stderr: string;
};
export type PluginCommandRunOptions = {
    argv: string[];
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
};
/** Run a plugin-managed command with timeout handling and normalized stdout/stderr results. */
export declare function runPluginCommandWithTimeout(options: PluginCommandRunOptions): Promise<PluginCommandRunResult>;
