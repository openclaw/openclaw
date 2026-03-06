import type { OpenClawConfig } from "./types.js";
export declare function collectConfigRuntimeEnvVars(cfg?: OpenClawConfig): Record<string, string>;
export declare function collectConfigServiceEnvVars(cfg?: OpenClawConfig): Record<string, string>;
/** @deprecated Use `collectConfigRuntimeEnvVars` or `collectConfigServiceEnvVars`. */
export declare function collectConfigEnvVars(cfg?: OpenClawConfig): Record<string, string>;
export declare function applyConfigEnvVars(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): void;
