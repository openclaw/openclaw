import { execFileSync } from "node:child_process";
export type ShellEnvFallbackResult = {
    ok: true;
    applied: string[];
    skippedReason?: never;
} | {
    ok: true;
    applied: [];
    skippedReason: "already-has-keys" | "disabled";
} | {
    ok: false;
    error: string;
    applied: [];
};
export type ShellEnvFallbackOptions = {
    enabled: boolean;
    env: NodeJS.ProcessEnv;
    expectedKeys: string[];
    logger?: Pick<typeof console, "warn">;
    timeoutMs?: number;
    exec?: typeof execFileSync;
};
export declare function loadShellEnvFallback(opts: ShellEnvFallbackOptions): ShellEnvFallbackResult;
export declare function shouldEnableShellEnvFallback(env: NodeJS.ProcessEnv): boolean;
export declare function shouldDeferShellEnvFallback(env: NodeJS.ProcessEnv): boolean;
export declare function resolveShellEnvFallbackTimeoutMs(env: NodeJS.ProcessEnv): number;
export declare function getShellPathFromLoginShell(opts: {
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    exec?: typeof execFileSync;
    platform?: NodeJS.Platform;
}): string | null;
export declare function resetShellPathCacheForTests(): void;
export declare function getShellEnvAppliedKeys(): string[];
