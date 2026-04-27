import type { SandboxBackendExecSpec } from "./sandbox/backend-handle.types.js";
export type BashSandboxConfig = {
    containerName: string;
    workspaceDir: string;
    containerWorkdir: string;
    env?: Record<string, string>;
    buildExecSpec?: (params: {
        command: string;
        workdir?: string;
        env: Record<string, string>;
        usePty: boolean;
    }) => Promise<SandboxBackendExecSpec>;
    finalizeExec?: (params: {
        status: "completed" | "failed";
        exitCode: number | null;
        timedOut: boolean;
        token?: unknown;
    }) => Promise<void>;
};
export declare function buildSandboxEnv(params: {
    defaultPath: string;
    paramsEnv?: Record<string, string>;
    sandboxEnv?: Record<string, string>;
    containerWorkdir: string;
}): Record<string, string>;
export declare function coerceEnv(env?: NodeJS.ProcessEnv | Record<string, string>): Record<string, string>;
export declare function buildDockerExecArgs(params: {
    containerName: string;
    command: string;
    workdir?: string;
    env: Record<string, string>;
    tty: boolean;
}): string[];
export declare function resolveSandboxWorkdir(params: {
    workdir: string;
    sandbox: BashSandboxConfig;
    warnings: string[];
}): Promise<{
    hostWorkdir: string;
    containerWorkdir: string;
}>;
export declare function resolveWorkdir(workdir: string, warnings: string[]): string;
/**
 * Clamp a number within min/max bounds, using defaultValue if undefined or NaN.
 */
export declare function clampWithDefault(value: number | undefined, defaultValue: number, min: number, max: number): number;
export declare function readEnvInt(key: string): number | undefined;
export declare function chunkString(input: string, limit?: number): string[];
export declare function truncateMiddle(str: string, max: number): string;
export declare function sliceLogLines(text: string, offset?: number, limit?: number): {
    slice: string;
    totalLines: number;
    totalChars: number;
};
export declare function deriveSessionName(command: string): string | undefined;
export declare function pad(str: string, width: number): string;
