import type { DaemonInstallOptions } from "./types.js";
export declare function mergeInstallInvocationEnv(params: {
    env: NodeJS.ProcessEnv;
    existingServiceEnv?: Record<string, string>;
}): NodeJS.ProcessEnv;
export declare function runDaemonInstall(opts: DaemonInstallOptions): Promise<void>;
