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
export declare function runPluginCommandWithTimeout(options: PluginCommandRunOptions): Promise<PluginCommandRunResult>;
