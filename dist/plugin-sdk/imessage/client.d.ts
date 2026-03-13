import type { RuntimeEnv } from "../runtime.js";
export type IMessageRpcError = {
    code?: number;
    message?: string;
    data?: unknown;
};
export type IMessageRpcResponse<T> = {
    jsonrpc?: string;
    id?: string | number | null;
    result?: T;
    error?: IMessageRpcError;
    method?: string;
    params?: unknown;
};
export type IMessageRpcNotification = {
    method: string;
    params?: unknown;
};
export type IMessageRpcClientOptions = {
    cliPath?: string;
    dbPath?: string;
    runtime?: RuntimeEnv;
    onNotification?: (msg: IMessageRpcNotification) => void;
};
export declare class IMessageRpcClient {
    private readonly cliPath;
    private readonly dbPath?;
    private readonly runtime?;
    private readonly onNotification?;
    private readonly pending;
    private readonly closed;
    private closedResolve;
    private child;
    private reader;
    private nextId;
    constructor(opts?: IMessageRpcClientOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    waitForClose(): Promise<void>;
    request<T = unknown>(method: string, params?: Record<string, unknown>, opts?: {
        timeoutMs?: number;
    }): Promise<T>;
    private handleLine;
    private failAll;
}
export declare function createIMessageRpcClient(opts?: IMessageRpcClientOptions): Promise<IMessageRpcClient>;
