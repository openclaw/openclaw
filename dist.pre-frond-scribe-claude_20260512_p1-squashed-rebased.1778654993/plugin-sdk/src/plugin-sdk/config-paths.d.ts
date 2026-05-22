import type { OpenClawConfig } from "../config/types.openclaw.js";
/** Resolve the config path prefix for a channel account, falling back to the root channel section. */
export declare function resolveChannelAccountConfigBasePath(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
}): string;
