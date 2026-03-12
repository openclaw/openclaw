import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelId } from "./types.js";
export declare function resolveChannelConfigWrites(params: {
    cfg: OpenClawConfig;
    channelId?: ChannelId | null;
    accountId?: string | null;
}): boolean;
