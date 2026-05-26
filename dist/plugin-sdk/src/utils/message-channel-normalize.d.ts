import { type InternalMessageChannel } from "./message-channel-constants.js";
type ChannelId = string & {
    readonly __openclawChannelIdBrand?: never;
};
export type DeliverableMessageChannel = ChannelId;
export type GatewayMessageChannel = DeliverableMessageChannel;
export declare function normalizeMessageChannel(raw?: string | null): string | undefined;
export declare const listDeliverableMessageChannels: () => ChannelId[];
export declare function isGatewayMessageChannel(value: string): value is GatewayMessageChannel;
export declare function isDeliverableMessageChannel(value: string): value is DeliverableMessageChannel;
export declare function resolveGatewayMessageChannel(raw?: string | null): GatewayMessageChannel | undefined;
export declare function resolveMessageChannel(primary?: string | null, fallback?: string | null): string | undefined;
export type { InternalMessageChannel };
