type PendingState<TPending> = {
    pendingById: Record<string, TPending>;
};
export declare function rejectPendingPairingRequest<TPending, TState extends PendingState<TPending>, TIdKey extends string>(params: {
    requestId: string;
    idKey: TIdKey;
    loadState: () => Promise<TState>;
    persistState: (state: TState) => Promise<void>;
    getId: (pending: TPending) => string;
}): Promise<({
    requestId: string;
} & Record<TIdKey, string>) | null>;
export {};
