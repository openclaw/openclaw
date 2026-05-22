import type { CliBackendConfig } from "../../config/types.js";
import type { EmbeddedRunTrigger } from "../pi-embedded-runner/run/params.js";
export declare function resolveCliNoOutputTimeoutMs(params: {
    backend: CliBackendConfig;
    timeoutMs: number;
    useResume: boolean;
    trigger?: EmbeddedRunTrigger;
}): number;
export declare function buildCliSupervisorScopeKey(params: {
    backend: CliBackendConfig;
    backendId: string;
    cliSessionId?: string;
}): string | undefined;
