import type { SlackMessageEvent } from "../types.js";
export declare function inferSlackChannelType(channelId?: string | null): SlackMessageEvent["channel_type"] | undefined;
export declare function normalizeSlackChannelType(channelType?: string | null, channelId?: string | null): SlackMessageEvent["channel_type"];
