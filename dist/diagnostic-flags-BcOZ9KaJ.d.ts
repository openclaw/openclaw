import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/infra/diagnostic-flags.d.ts
declare function resolveDiagnosticFlags(cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv): string[];
declare function matchesDiagnosticFlag(flag: string, enabledFlags: string[]): boolean;
declare function isDiagnosticFlagEnabled(flag: string, cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean;
//#endregion
export { matchesDiagnosticFlag as n, resolveDiagnosticFlags as r, isDiagnosticFlagEnabled as t };