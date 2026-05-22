import type { ChannelMessageActionAdapter, ChannelMessageToolDiscovery } from "openclaw/plugin-sdk/channel-contract";
export declare function describeSlackMessageTool({ cfg, accountId, }: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]): ChannelMessageToolDiscovery;
