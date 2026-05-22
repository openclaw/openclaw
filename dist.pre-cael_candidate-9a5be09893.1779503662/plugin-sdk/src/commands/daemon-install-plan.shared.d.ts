import { type DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";
export declare function resolveGatewayDevMode(argv?: string[]): boolean;
export declare function resolveDaemonInstallRuntimeInputs(params: {
    env: Record<string, string | undefined>;
    runtime: GatewayDaemonRuntime;
    devMode?: boolean;
    nodePath?: string;
}): Promise<{
    devMode: boolean;
    nodePath?: string;
}>;
export declare function emitDaemonInstallRuntimeWarning(params: {
    env: Record<string, string | undefined>;
    runtime: GatewayDaemonRuntime;
    programArguments: string[];
    warn?: DaemonInstallWarnFn;
    title: string;
}): Promise<void>;
export declare function resolveDaemonNodeBinDir(nodePath?: string): string[] | undefined;
export declare function resolveDaemonOpenClawBinDir(params?: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    existsSync?: (path: string) => boolean;
    realpathSync?: (path: string) => string;
}): string[] | undefined;
export declare function resolveDaemonServicePathDirs(params: {
    nodePath?: string;
    argv?: string[];
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
}): string[] | undefined;
