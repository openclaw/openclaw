import { type ChannelMatchSource } from "openclaw/plugin-sdk/channel-targets";
import type { ChannelBotLoopProtectionConfig } from "openclaw/plugin-sdk/config-contracts";
export type SlackChannelConfigResolved = {
    allowed: boolean;
    requireMention: boolean;
    allowBots?: boolean | "mentions";
    botLoopProtection?: ChannelBotLoopProtectionConfig;
    users?: Array<string | number>;
    skills?: string[];
    systemPrompt?: string;
    matchKey?: string;
    matchSource?: ChannelMatchSource;
};
type SlackChannelConfigEntry = {
    enabled?: boolean;
    requireMention?: boolean;
    allowBots?: boolean | "mentions";
    botLoopProtection?: ChannelBotLoopProtectionConfig;
    users?: Array<string | number>;
    skills?: string[];
    systemPrompt?: string;
};
export type SlackChannelConfigEntries = Record<string, SlackChannelConfigEntry>;
export declare function resolveSlackChannelLabel(params: {
    channelId?: string;
    channelName?: string;
}): string;
export declare function resolveSlackChannelConfig(params: {
    channelId: string;
    channelName?: string;
    channels?: SlackChannelConfigEntries;
    channelKeys?: string[];
    defaultRequireMention?: boolean;
    allowNameMatching?: boolean;
}): SlackChannelConfigResolved | null;
export {};
