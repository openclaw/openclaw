export type CliSpawnInvocation = {
    command: string;
    argv: string[];
    shell?: boolean;
    windowsHide?: boolean;
};
export type QmdBinaryAvailability = {
    available: boolean;
    error?: string;
};
export declare function resolveCliSpawnInvocation(params: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    packageName: string;
}): CliSpawnInvocation;
export declare function checkQmdBinaryAvailability(params: {
    command: string;
    env: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
}): Promise<QmdBinaryAvailability>;
export declare function runCliCommand(params: {
    commandSummary: string;
    spawnInvocation: CliSpawnInvocation;
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs?: number;
    maxOutputChars: number;
    discardStdout?: boolean;
}): Promise<{
    stdout: string;
    stderr: string;
}>;
