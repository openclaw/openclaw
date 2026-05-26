export type StdioMcpServerLaunchConfig = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
};
type StdioMcpServerLaunchResult = {
    ok: true;
    config: StdioMcpServerLaunchConfig;
} | {
    ok: false;
    reason: string;
};
export declare function resolveStdioMcpServerLaunchConfig(raw: unknown, options?: {
    onDroppedEnv?: (key: string, value: unknown) => void;
}): StdioMcpServerLaunchResult;
export declare function describeStdioMcpServerLaunchConfig(config: StdioMcpServerLaunchConfig): string;
export {};
