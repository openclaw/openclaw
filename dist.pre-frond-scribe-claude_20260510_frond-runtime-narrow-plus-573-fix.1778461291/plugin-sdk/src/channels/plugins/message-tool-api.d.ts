import type { ChannelMessageActionAdapter, ChannelMessageToolDiscovery } from "./types.public.js";
export type ChannelMessageToolDiscoveryAdapter = Pick<ChannelMessageActionAdapter, "describeMessageTool">;
export declare function resolveBundledChannelMessageToolDiscoveryAdapter(channelId: string): ChannelMessageToolDiscoveryAdapter | undefined;
export declare function describeBundledChannelMessageTool(params: {
    channelId: string;
    context: Parameters<NonNullable<ChannelMessageToolDiscoveryAdapter["describeMessageTool"]>>[0];
}): ChannelMessageToolDiscovery | null | undefined;
