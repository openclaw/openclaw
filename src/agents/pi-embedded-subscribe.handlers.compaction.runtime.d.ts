export declare function reconcileSessionStoreCompactionCountAfterSuccess(params: {
    sessionKey?: string;
    agentId?: string;
    configStore?: string;
    observedCompactionCount: number;
    now?: number;
}): Promise<number | undefined>;
