export type SignalRpcOptions = {
    baseUrl: string;
    timeoutMs?: number;
};
export type SignalRpcError = {
    code?: number;
    message?: string;
    data?: unknown;
};
export type SignalRpcResponse<T> = {
    jsonrpc?: string;
    result?: T;
    error?: SignalRpcError;
    id?: string | number | null;
};
export type SignalSseEvent = {
    event?: string;
    data?: string;
    id?: string;
};
export declare function signalRpcRequest<T = unknown>(method: string, params: Record<string, unknown> | undefined, opts: SignalRpcOptions): Promise<T>;
export declare function signalCheck(baseUrl: string, timeoutMs?: number): Promise<{
    ok: boolean;
    status?: number | null;
    error?: string | null;
}>;
export declare function streamSignalEvents(params: {
    baseUrl: string;
    account?: string;
    abortSignal?: AbortSignal;
    onEvent: (event: SignalSseEvent) => void;
}): Promise<void>;
