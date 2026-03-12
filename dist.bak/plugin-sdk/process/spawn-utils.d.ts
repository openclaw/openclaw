import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
export type SpawnFallback = {
    label: string;
    options: SpawnOptions;
};
export type SpawnWithFallbackResult = {
    child: ChildProcess;
    usedFallback: boolean;
    fallbackLabel?: string;
};
type SpawnWithFallbackParams = {
    argv: string[];
    options: SpawnOptions;
    fallbacks?: SpawnFallback[];
    spawnImpl?: typeof spawn;
    retryCodes?: string[];
    onFallback?: (err: unknown, fallback: SpawnFallback) => void;
};
export declare function resolveCommandStdio(params: {
    hasInput: boolean;
    preferInherit: boolean;
}): ["pipe" | "inherit" | "ignore", "pipe", "pipe"];
export declare function formatSpawnError(err: unknown): string;
export declare function spawnWithFallback(params: SpawnWithFallbackParams): Promise<SpawnWithFallbackResult>;
export {};
