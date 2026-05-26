import { type ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
export type CompletionChatType = ChatType | "unknown";
export type CompletionDeliverySessionEntry = {
    chatType?: string | null;
    origin?: {
        chatType?: string | null;
    } | null;
};
export declare function resolveCompletionChatType(params: {
    requesterSessionKey?: string | null;
    targetRequesterSessionKey?: string | null;
    requesterEntry?: CompletionDeliverySessionEntry;
    directOrigin?: DeliveryContext;
    requesterSessionOrigin?: DeliveryContext;
}): CompletionChatType;
export declare function completionRequiresMessageToolDelivery(params: {
    cfg: OpenClawConfig;
    requesterSessionKey?: string | null;
    targetRequesterSessionKey?: string | null;
    requesterEntry?: CompletionDeliverySessionEntry;
    directOrigin?: DeliveryContext;
    requesterSessionOrigin?: DeliveryContext;
    messageToolAvailable?: boolean;
}): boolean;
export declare function shouldRouteCompletionThroughRequesterSession(sessionKey: string | undefined | null): boolean;
