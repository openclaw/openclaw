import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";
export declare function inspectChannelAccount(params: {
    plugin: ChannelPlugin;
    cfg: OpenClawConfig;
    accountId: string;
}): Promise<unknown>;
export declare function resolveInspectedChannelAccount(params: {
    plugin: ChannelPlugin;
    cfg: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    accountId: string;
}): Promise<{
    account: unknown;
    enabled: boolean;
    configured: boolean;
}>;
