import type { CliBackendConfig } from "../../config/types.js";
export declare function resolveCliNoOutputTimeoutMs(params: {
    backend: CliBackendConfig;
    timeoutMs: number;
    useResume: boolean;
}): number;
export declare function buildCliSupervisorScopeKey(params: {
    backend: CliBackendConfig;
    backendId: string;
    cliSessionId?: string;
}): string | undefined;
