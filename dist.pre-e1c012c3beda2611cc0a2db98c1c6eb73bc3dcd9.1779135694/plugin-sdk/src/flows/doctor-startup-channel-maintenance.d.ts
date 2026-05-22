import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type DoctorStartupMaintenanceRuntime = {
    error: (message: string) => void;
    log: (message: string) => void;
};
type ChannelPluginStartupMaintenanceRunner = typeof runChannelPluginStartupMaintenance;
export declare function maybeRunDoctorStartupChannelMaintenance(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    runChannelPluginStartupMaintenance?: ChannelPluginStartupMaintenanceRunner;
    runtime: DoctorStartupMaintenanceRuntime;
    shouldRepair: boolean;
}): Promise<void>;
export {};
