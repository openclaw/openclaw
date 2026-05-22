import { type ChannelRouteRef } from "../plugin-sdk/channel-route.js";
import type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";
export declare function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined;
export declare function normalizeDeliveryChannelRoute(route?: unknown): ChannelRouteRef | undefined;
export declare function deliveryContextFromChannelRoute(route?: ChannelRouteRef): DeliveryContext | undefined;
export declare function channelRouteFromDeliveryContext(context?: DeliveryContext): ChannelRouteRef | undefined;
export declare function normalizeSessionDeliveryFields(source?: DeliveryContextSessionSource): {
    route?: ChannelRouteRef;
    deliveryContext?: DeliveryContext;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
};
export declare function deliveryContextFromSession(entry?: DeliveryContextSessionSource): DeliveryContext | undefined;
export declare function mergeDeliveryContext(primary?: DeliveryContext, fallback?: DeliveryContext): DeliveryContext | undefined;
export declare function deliveryContextKey(context?: DeliveryContext): string | undefined;
