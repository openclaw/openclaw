import type { OpenClawConfig } from "./types.js";
export declare function readStateDirDotEnvVarsFromStateDir(stateDir: string): Record<string, string>;
/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
 * a filtered record of key-value pairs suitable for a managed service
 * environment source.
 */
export declare function readStateDirDotEnvVars(env: Record<string, string | undefined>): Record<string, string>;
export type DurableServiceEnvVarSources = {
    stateDirDotEnvEnvironment: Record<string, string>;
    configEnvironment: Record<string, string>;
    durableEnvironment: Record<string, string>;
};
export declare function collectDurableServiceEnvVarSources(params: {
    env: Record<string, string | undefined>;
    config?: OpenClawConfig;
}): DurableServiceEnvVarSources;
/**
 * Durable service env sources survive beyond the invoking shell and are safe to
 * persist into owner-only gateway service environment sources.
 *
 * Precedence:
 * 1. state-dir `.env` file vars
 * 2. config service env vars
 */
export declare function collectDurableServiceEnvVars(params: {
    env: Record<string, string | undefined>;
    config?: OpenClawConfig;
}): Record<string, string>;
