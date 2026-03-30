export type DeliveryContext = {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
};
export type DeliveryContextSessionSource = {
    channel?: string;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
    deliveryContext?: DeliveryContext;
};
export declare function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined;
export declare function normalizeSessionDeliveryFields(source?: DeliveryContextSessionSource): {
    deliveryContext?: DeliveryContext;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
};
export declare function deliveryContextFromSession(entry?: DeliveryContextSessionSource & {
    origin?: {
        threadId?: string | number;
    };
}): DeliveryContext | undefined;
export declare function mergeDeliveryContext(primary?: DeliveryContext, fallback?: DeliveryContext): DeliveryContext | undefined;
export declare function deliveryContextKey(context?: DeliveryContext): string | undefined;
