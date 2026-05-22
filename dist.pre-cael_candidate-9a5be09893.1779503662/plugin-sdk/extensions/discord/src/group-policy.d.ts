import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import { type GroupToolPolicyConfig } from "openclaw/plugin-sdk/channel-policy";
export declare function resolveDiscordGroupRequireMention(params: ChannelGroupContext): boolean;
export declare function resolveDiscordGroupToolPolicy(params: ChannelGroupContext): GroupToolPolicyConfig | undefined;
