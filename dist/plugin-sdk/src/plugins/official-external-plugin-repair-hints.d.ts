import type { OpenClawConfig } from "../config/types.openclaw.js";
export type OfficialExternalPluginRepairHint = {
    pluginId: string;
    channelId?: string;
    label: string;
    installSpec: string;
    installCommand: string;
    doctorFixCommand: string;
    repairHint: string;
};
export declare function resolveOfficialExternalPluginRepairHint(pluginIdOrChannelId: string): OfficialExternalPluginRepairHint | null;
export declare function resolveMissingOfficialExternalChannelPluginRepairHint(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    channelId: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): OfficialExternalPluginRepairHint | null;
