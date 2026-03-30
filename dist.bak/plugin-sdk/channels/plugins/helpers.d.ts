import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelPlugin } from "./types.js";
export declare function resolveChannelDefaultAccountId<ResolvedAccount>(params: {
    plugin: ChannelPlugin<ResolvedAccount>;
    cfg: OpenClawConfig;
    accountIds?: string[];
}): string;
export declare function formatPairingApproveHint(channelId: string): string;
