import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceCommandConfig, GatewayServiceControlArgs, GatewayServiceEnv, GatewayServiceEnvArgs, GatewayServiceInstallArgs, GatewayServiceManageArgs, GatewayServiceRestartResult } from "./service-types.js";
export declare function resolveLaunchAgentPlistPath(env: GatewayServiceEnv): string;
export declare function readLaunchAgentProgramArguments(env: GatewayServiceEnv): Promise<GatewayServiceCommandConfig | null>;
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
export declare function uninstallLaunchAgent({ env, stdout }: GatewayServiceManageArgs): Promise<void>;
export declare function stopLaunchAgent({ stdout, env }: GatewayServiceControlArgs): Promise<void>;
export declare function stageLaunchAgent({ stdout, ...args }: GatewayServiceInstallArgs): Promise<{
    plistPath: string;
}>;
export declare function installLaunchAgent(args: GatewayServiceInstallArgs): Promise<{
    plistPath: string;
}>;
export declare function restartLaunchAgent({ stdout, env }: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult>;
export {};
