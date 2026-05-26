import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function listBundledChannelIdsWithConfiguredState(): string[];
export declare function hasBundledChannelConfiguredState(params: {
    channelId: string;
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): boolean;
