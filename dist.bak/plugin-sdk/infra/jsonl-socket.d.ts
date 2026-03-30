export declare function requestJsonlSocket<T>(params: {
    socketPath: string;
    payload: string;
    timeoutMs: number;
    accept: (msg: unknown) => T | null | undefined;
}): Promise<T | null>;
