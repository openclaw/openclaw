import type { OpenClawConfig } from "../config/config.js";
import type { ChannelAccountSnapshot } from "./plugins/types.core.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";
export declare function buildChannelAccountSnapshot(params: {
    plugin: ChannelPlugin;
    account: unknown;
    cfg: OpenClawConfig;
    accountId: string;
    enabled: boolean;
    configured: boolean;
}): ChannelAccountSnapshot;
export declare function formatChannelAllowFrom(params: {
    plugin: ChannelPlugin;
    cfg: OpenClawConfig;
    accountId?: string | null;
    allowFrom: Array<string | number>;
}): string[];
