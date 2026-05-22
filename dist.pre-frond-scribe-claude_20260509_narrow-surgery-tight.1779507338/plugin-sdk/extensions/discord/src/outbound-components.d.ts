import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { type DiscordComponentMessageSpec } from "./components.js";
type DiscordComponentSendFn = typeof import("./send.components.js").sendDiscordComponentMessage;
type OutboundPayload = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["payload"];
export declare function sendDiscordComponentMessageLazy(...args: Parameters<DiscordComponentSendFn>): ReturnType<DiscordComponentSendFn>;
export declare function buildDiscordPresentationPayload(params: {
    payload: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0]["payload"];
    presentation: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0]["presentation"];
}): Promise<typeof params.payload | null>;
export declare function resolveDiscordComponentSpec(payload: OutboundPayload): Promise<DiscordComponentMessageSpec | undefined>;
export {};
