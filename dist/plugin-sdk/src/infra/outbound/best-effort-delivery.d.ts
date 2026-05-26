export type ExternalBestEffortDeliveryTarget = {
    deliver: boolean;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
};
export declare function resolveExternalBestEffortDeliveryTarget(params: {
    channel?: string | null;
    to?: string | null;
    accountId?: string | null;
    threadId?: string | number | null;
}): ExternalBestEffortDeliveryTarget;
export declare function shouldDowngradeDeliveryToSessionOnly(params: {
    wantsDelivery: boolean;
    bestEffortDeliver: boolean;
    resolvedChannel: string;
}): boolean;
