import type { OpenClawConfig } from "../config/config.js";
export declare function resolveDiagnosticFlags(cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv): string[];
export declare function matchesDiagnosticFlag(flag: string, enabledFlags: string[]): boolean;
export declare function isDiagnosticFlagEnabled(flag: string, cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean;
