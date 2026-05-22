import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceCommandConfig, GatewayServiceControlArgs, GatewayServiceEnv, GatewayServiceEnvArgs, GatewayServiceInstallArgs, GatewayServiceManageArgs, GatewayServiceRestartResult } from "./service-types.js";
export declare function resolveTaskScriptPath(env: GatewayServiceEnv): string;
export declare function readScheduledTaskCommand(env: GatewayServiceEnv): Promise<GatewayServiceCommandConfig | null>;
export type ScheduledTaskInfo = {
    status?: string;
    lastRunTime?: string;
    lastRunResult?: string;
};
export declare function parseSchtasksQuery(output: string): ScheduledTaskInfo;
export declare function deriveScheduledTaskRuntimeStatus(parsed: ScheduledTaskInfo): {
    status: GatewayServiceRuntime["status"];
    detail?: string;
};
export declare function stageScheduledTask({ stdout, ...args }: GatewayServiceInstallArgs): Promise<{
    scriptPath: string;
}>;
export declare function installScheduledTask(args: GatewayServiceInstallArgs): Promise<{
    scriptPath: string;
}>;
export declare function uninstallScheduledTask({ env, stdout }: GatewayServiceManageArgs): Promise<void>;
export declare function stopScheduledTask({ stdout, env }: GatewayServiceControlArgs): Promise<void>;
export declare function restartScheduledTask({ stdout, env }: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult>;
export declare function isScheduledTaskInstalled(args: GatewayServiceEnvArgs): Promise<boolean>;
export declare function readScheduledTaskRuntime(env?: GatewayServiceEnv): Promise<GatewayServiceRuntime>;
