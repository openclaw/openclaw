import type { OpenClawConfig } from "../config/types.openclaw.js";
export { isSafeChannelEnvVarTriggerName } from "./channel-env-var-names.js";
type ChannelEnvVarLookupParams = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
};
export declare function resolveChannelEnvVars(params?: ChannelEnvVarLookupParams): Record<string, readonly string[]>;
export declare function getChannelEnvVars(channelId: string, params?: ChannelEnvVarLookupParams): string[];
export declare function listKnownChannelEnvVarNames(params?: ChannelEnvVarLookupParams): string[];
