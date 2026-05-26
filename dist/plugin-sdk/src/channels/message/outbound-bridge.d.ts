import type { ChannelMessageAdapterShape, ChannelMessageLiveAdapterShape, ChannelMessageReceiveAdapterShape, ChannelMessageSendMediaContext, ChannelMessageSendPayloadContext, ChannelMessageSendPollContext, ChannelMessageSendTextContext, DurableFinalDeliveryRequirementMap, MessageReceipt, MessageReceiptSourceResult } from "./types.js";
export type ChannelMessageOutboundBridgeResult = MessageReceiptSourceResult & {
    receipt?: MessageReceipt;
    messageId?: string;
};
export type ChannelMessageOutboundBridgeAdapter<TConfig = unknown> = {
    deliveryCapabilities?: {
        durableFinal?: DurableFinalDeliveryRequirementMap;
    };
    sendText?: (ctx: ChannelMessageSendTextContext<TConfig>) => Promise<ChannelMessageOutboundBridgeResult>;
    sendMedia?: (ctx: ChannelMessageSendMediaContext<TConfig>) => Promise<ChannelMessageOutboundBridgeResult>;
    sendPayload?: (ctx: ChannelMessageSendPayloadContext<TConfig>) => Promise<ChannelMessageOutboundBridgeResult>;
    sendPoll?: (ctx: ChannelMessageSendPollContext<TConfig>) => Promise<ChannelMessageOutboundBridgeResult>;
};
export type CreateChannelMessageAdapterFromOutboundParams<TConfig = unknown> = {
    id?: string;
    outbound: ChannelMessageOutboundBridgeAdapter<TConfig>;
    capabilities?: DurableFinalDeliveryRequirementMap;
    live?: ChannelMessageLiveAdapterShape;
    receive?: ChannelMessageReceiveAdapterShape;
};
export declare function createChannelMessageAdapterFromOutbound<TConfig = unknown>(params: CreateChannelMessageAdapterFromOutboundParams<TConfig>): ChannelMessageAdapterShape<TConfig>;
