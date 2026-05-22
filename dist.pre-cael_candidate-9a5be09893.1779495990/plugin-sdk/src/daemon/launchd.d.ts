import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceCommandConfig, GatewayServiceControlArgs, GatewayServiceEnv, GatewayServiceEnvArgs, GatewayServiceInstallArgs, GatewayServiceManageArgs, GatewayServiceRestartResult } from "./service-types.js";
export type StaleOpenClawUpdateLaunchdJob = {
    label: string;
    pid?: number;
    lastExitStatus?: number;
};
export declare function isOpenClawUpdateLaunchdLabel(label: unknown): label is string;
export declare function resolveLaunchAgentPlistPath(env: GatewayServiceEnv): string;
export declare function readLaunchAgentProgramArguments(env: GatewayServiceEnv): Promise<GatewayServiceCommandConfig | null>;
export declare function parseLaunchctlListOpenClawUpdateJobs(output: string): StaleOpenClawUpdateLaunchdJob[];
export declare function findStaleOpenClawUpdateLaunchdJobs(): Promise<StaleOpenClawUpdateLaunchdJob[]>;
export declare function removeOpenClawUpdateLaunchdJob(label: string): Promise<boolean>;
export declare function disableOpenClawUpdateLaunchdJob(label: string): Promise<boolean>;
export declare function disableCurrentOpenClawUpdateLaunchdJob(env?: NodeJS.ProcessEnv): Promise<boolean>;
type LaunchctlPrintInfo = {
    state?: string;
    pid?: number;
    lastExitStatus?: number;
    lastExitReason?: string;
};
export declare function parseLaunchctlPrint(output: string): LaunchctlPrintInfo;
export declare function isLaunchAgentLoaded(args: GatewayServiceEnvArgs): Promise<boolean>;
export declare function isLaunchAgentListed(args: GatewayServiceEnvArgs): Promise<boolean>;
export declare function launchAgentPlistExists(env: GatewayServiceEnv): Promise<boolean>;
export declare function readLaunchAgentRuntime(env: Record<string, string | undefined>): Promise<GatewayServiceRuntime>;
type LaunchAgentBootstrapRepairResult = {
    ok: true;
    status: "repaired" | "already-loaded";
} | {
    ok: false;
    status: "bootstrap-failed" | "kickstart-failed";
    detail?: string;
};
export declare function repairLaunchAgentBootstrap(args: {
    env?: Record<string, string | undefined>;
}): Promise<LaunchAgentBootstrapRepairResult>;
export declare function uninstallLaunchAgent({ env, stdout, }: GatewayServiceManageArgs): Promise<void>;
export declare function stopLaunchAgent({ stdout, env, disable: persistDisable, }: GatewayServiceControlArgs): Promise<void>;
export declare function stageLaunchAgent({ stdout, ...args }: GatewayServiceInstallArgs): Promise<{
    plistPath: string;
}>;
export declare function installLaunchAgent(args: GatewayServiceInstallArgs): Promise<{
    plistPath: string;
}>;
export declare function restartLaunchAgent({ stdout, env, }: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult>;
export {};
