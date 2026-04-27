export type DeliveryContext = {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
};
type DeliveryContextSource = {
    channel?: string;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
    origin?: {
        provider?: string;
        accountId?: string;
        threadId?: string | number;
    };
    deliveryContext?: DeliveryContext;
};
export declare function resolveAnnounceOrigin(entry?: DeliveryContextSource, requesterOrigin?: DeliveryContext): DeliveryContext | undefined;
export {};
