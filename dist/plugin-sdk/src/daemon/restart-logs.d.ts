import type { GatewayServiceEnv } from "./service-types.js";
export declare const GATEWAY_RESTART_LOG_FILENAME = "gateway-restart.log";
export type GatewayLogPaths = {
    logDir: string;
    stdoutPath: string;
    stderrPath: string;
};
export declare function resolveGatewayLogPaths(env: GatewayServiceEnv): GatewayLogPaths;
export declare function resolveMacLaunchAgentLogPaths(env: GatewayServiceEnv): GatewayLogPaths;
export declare function resolveGatewaySupervisorLogPaths(env: GatewayServiceEnv, options?: {
    platform?: NodeJS.Platform;
}): GatewayLogPaths;
export declare function resolveGatewayRestartLogPath(env: GatewayServiceEnv): string;
export declare function shellEscapeRestartLogValue(value: string): string;
export declare function renderPosixRestartLogSetup(env: GatewayServiceEnv): string;
export declare function renderCmdRestartLogSetup(env: GatewayServiceEnv): {
    lines: string[];
    quotedLogPath: string;
};
