export type IMessageMonitorClient = {
    request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    stop: () => Promise<void>;
};
export declare function attachIMessageMonitorAbortHandler(params: {
    abortSignal?: AbortSignal;
    client: IMessageMonitorClient;
    getSubscriptionId: () => number | null;
}): () => void;
