import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import { type GroupToolPolicyConfig } from "openclaw/plugin-sdk/channel-policy";
export declare function resolveSlackGroupRequireMention(params: ChannelGroupContext): boolean;
export declare function resolveSlackGroupToolPolicy(params: ChannelGroupContext): GroupToolPolicyConfig | undefined;
