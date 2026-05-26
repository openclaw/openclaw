import type { SessionEntry } from "../config/sessions/types.js";
import type { ConversationRef, SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import { type ChannelRouteChatType, type ChannelRouteRef } from "../plugin-sdk/channel-route.js";
import { type DeliveryContext } from "../utils/delivery-context.js";
export type RoutableChannelRouteRef = ChannelRouteRef & {
    channel: string;
    target: {
        to: string;
        rawTo?: string;
        chatType?: ChannelRouteChatType;
    };
};
export type SessionRouteDeliveryFields = {
    route?: ChannelRouteRef;
    deliveryContext?: DeliveryContext;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
};
export declare function normalizeRoutableChannelRoute(route?: ChannelRouteRef | null): RoutableChannelRouteRef | undefined;
export declare function routeFromDeliveryContext(context?: DeliveryContext): ChannelRouteRef | undefined;
export declare function deliveryContextFromRoute(route?: ChannelRouteRef): DeliveryContext | undefined;
export declare function routeFromSessionEntry(entry?: SessionEntry | null): ChannelRouteRef | undefined;
export declare function sessionDeliveryFieldsFromRoute(route?: ChannelRouteRef): SessionRouteDeliveryFields;
export declare function routeFromConversationRef(conversation?: ConversationRef | null): ChannelRouteRef | undefined;
export declare function routableRouteFromConversationRef(conversation?: ConversationRef | null): RoutableChannelRouteRef | undefined;
export declare function routeFromBindingRecord(binding?: SessionBindingRecord | null): ChannelRouteRef | undefined;
export declare function routableRouteFromBindingRecord(binding?: SessionBindingRecord | null): RoutableChannelRouteRef | undefined;
export declare function routeToDeliveryFields(route?: ChannelRouteRef): {
    deliveryContext?: DeliveryContext;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
};
export declare function routesShareDeliveryTarget(params: {
    left?: ChannelRouteRef | null;
    right?: ChannelRouteRef | null;
}): boolean;
