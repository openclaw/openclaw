import type { OpenClawConfig } from "../config/config.js";
import { type InspectedDiscordAccount } from "../discord/account-inspect.js";
import { type InspectedSlackAccount } from "../slack/account-inspect.js";
import { type InspectedTelegramAccount } from "../telegram/account-inspect.js";
import type { ChannelId } from "./plugins/types.js";
export type ReadOnlyInspectedAccount = InspectedDiscordAccount | InspectedSlackAccount | InspectedTelegramAccount;
export declare function inspectReadOnlyChannelAccount(params: {
    channelId: ChannelId;
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ReadOnlyInspectedAccount | null;
