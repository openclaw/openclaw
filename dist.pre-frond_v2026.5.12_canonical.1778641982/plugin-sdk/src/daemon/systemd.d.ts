import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceCommandConfig, GatewayServiceControlArgs, GatewayServiceEnv, GatewayServiceEnvArgs, GatewayServiceInstallArgs, GatewayServiceManageArgs, GatewayServiceRestartResult } from "./service-types.js";
import { enableSystemdUserLinger, readSystemdUserLingerStatus } from "./systemd-linger.js";
export declare function resolveSystemdUserUnitPath(env: GatewayServiceEnv): string;
export { enableSystemdUserLinger, readSystemdUserLingerStatus };
export declare function readSystemdServiceExecStart(env: GatewayServiceEnv): Promise<GatewayServiceCommandConfig | null>;
type SystemdServiceInfo = {
    activeState?: string;
    subState?: string;
    mainPid?: number;
    execMainStatus?: number;
    execMainCode?: string;
};
export declare function parseSystemdShow(output: string): SystemdServiceInfo;
export type SystemdUnitScope = "system" | "user";
export declare function isNonFatalSystemdInstallProbeError(error: unknown): boolean;
export declare function isSystemdUserServiceAvailable(env?: GatewayServiceEnv): Promise<boolean>;
export declare function isSystemdUnitActive(env: GatewayServiceEnv, unitName: string, scope?: SystemdUnitScope): Promise<boolean>;
export declare function stageSystemdService({ stdout, ...args }: GatewayServiceInstallArgs): Promise<{
    unitPath: string;
}>;
export declare function installSystemdService(args: GatewayServiceInstallArgs): Promise<{
    unitPath: string;
}>;
export declare function uninstallSystemdService({ env, stdout }: GatewayServiceManageArgs): Promise<void>;
export declare function stopSystemdService({ stdout, env }: GatewayServiceControlArgs): Promise<void>;
export declare function restartSystemdService({ stdout, env }: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult>;
export declare function isSystemdServiceEnabled(args: GatewayServiceEnvArgs): Promise<boolean>;
export declare function readSystemdServiceRuntime(env?: GatewayServiceEnv): Promise<GatewayServiceRuntime>;
type LegacySystemdUnit = {
    name: string;
    unitPath: string;
    enabled: boolean;
    exists: boolean;
};
export declare function uninstallLegacySystemdUnits({ env, stdout }: GatewayServiceManageArgs): Promise<LegacySystemdUnit[]>;
