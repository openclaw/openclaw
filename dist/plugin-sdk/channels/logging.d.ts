export type LogFn = (message: string) => void;
export declare function logInboundDrop(params: {
    log: LogFn;
    channel: string;
    reason: string;
    target?: string;
}): void;
export declare function logTypingFailure(params: {
    log: LogFn;
    channel: string;
    target?: string;
    action?: "start" | "stop";
    error: unknown;
}): void;
export declare function logAckFailure(params: {
    log: LogFn;
    channel: string;
    target?: string;
    error: unknown;
}): void;
