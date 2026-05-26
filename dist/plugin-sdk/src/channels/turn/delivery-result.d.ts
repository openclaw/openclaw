import type { MessageReceipt } from "../message/types.js";
import type { ChannelDeliveryIntent, ChannelDeliveryResult } from "./types.js";
export declare function createChannelDeliveryResultFromReceipt(params: {
    receipt: MessageReceipt;
    threadId?: string;
    replyToId?: string;
    visibleReplySent?: boolean;
    deliveryIntent?: ChannelDeliveryIntent;
}): ChannelDeliveryResult;
