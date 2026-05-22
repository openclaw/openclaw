import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, type GatewayClientMode, type GatewayClientName, normalizeGatewayClientMode, normalizeGatewayClientName } from "../gateway/protocol/client-info.js";
export { isDeliverableMessageChannel, isGatewayMessageChannel, listDeliverableMessageChannels, normalizeMessageChannel, resolveGatewayMessageChannel, resolveMessageChannel, type DeliverableMessageChannel, type GatewayMessageChannel, } from "./message-channel-normalize.js";
export { INTERNAL_MESSAGE_CHANNEL, INTERNAL_NON_DELIVERY_CHANNELS, isInternalNonDeliveryChannel, type InternalMessageChannel, } from "./message-channel-constants.js";
import { type InternalMessageChannel } from "./message-channel-constants.js";
export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export type { GatewayClientName, GatewayClientMode };
export { normalizeGatewayClientName, normalizeGatewayClientMode };
type GatewayClientInfoLike = {
    mode?: string | null;
    id?: string | null;
};
export declare function isGatewayCliClient(client?: GatewayClientInfoLike | null): boolean;
export declare function isOperatorUiClient(client?: GatewayClientInfoLike | null): boolean;
export declare function isBrowserOperatorUiClient(client?: GatewayClientInfoLike | null): boolean;
export declare function isInternalMessageChannel(raw?: string | null): raw is InternalMessageChannel;
export declare function isWebchatClient(client?: GatewayClientInfoLike | null): boolean;
export declare function isMarkdownCapableMessageChannel(raw?: string | null): boolean;
