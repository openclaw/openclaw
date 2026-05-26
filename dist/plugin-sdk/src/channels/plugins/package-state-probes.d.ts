import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type ChannelPackageStateMetadataKey = "configuredState" | "persistedAuthState";
export declare function listBundledChannelIdsForPackageState(metadataKey: ChannelPackageStateMetadataKey): string[];
export declare function hasBundledChannelPackageState(params: {
    metadataKey: ChannelPackageStateMetadataKey;
    channelId: string;
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): boolean;
