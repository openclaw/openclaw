import { type ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
export declare function sendDiscordOutboundPayload(params: {
    ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
    fallbackAdapter: ChannelOutboundAdapter;
}): Promise<Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>>;
