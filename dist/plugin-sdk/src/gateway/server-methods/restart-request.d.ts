type RestartDeliveryContext = {
    channel?: string;
    to?: string;
    accountId?: string;
};
export declare function parseRestartRequestParams(params: unknown): {
    sessionKey: string | undefined;
    deliveryContext: RestartDeliveryContext | undefined;
    threadId: string | undefined;
    note: string | undefined;
    continuationMessage: string | undefined;
    restartDelayMs: number | undefined;
};
export {};
