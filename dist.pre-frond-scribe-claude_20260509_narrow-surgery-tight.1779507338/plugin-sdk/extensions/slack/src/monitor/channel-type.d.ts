import type { SlackMessageEvent } from "../types.js";
type SlackChatType = "direct" | "group" | "channel";
export declare function inferSlackChannelType(channelId?: string | null): SlackMessageEvent["channel_type"] | undefined;
export declare function normalizeSlackChannelType(channelType?: string | null, channelId?: string | null): SlackMessageEvent["channel_type"];
export declare function resolveSlackChatType(channelType: SlackMessageEvent["channel_type"]): SlackChatType;
export {};
