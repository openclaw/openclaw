import type { ChannelMeta } from "./types.core.js";
export declare function resolveChannelExposure(meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">): {
    configured: boolean;
    setup: boolean;
    docs: boolean;
};
export declare function isChannelVisibleInConfiguredLists(meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">): boolean;
export declare function isChannelVisibleInSetup(meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">): boolean;
