type CloseAwareServer = {
    once: (event: "close", listener: () => void) => unknown;
};
/**
 * Return a promise that resolves when the signal is aborted.
 *
 * If no signal is provided, the promise stays pending forever.
 */
export declare function waitUntilAbort(signal?: AbortSignal): Promise<void>;
/**
 * Keep a channel/provider task pending until the HTTP server closes.
 *
 * When an abort signal is provided, `onAbort` is invoked once and should
 * trigger server shutdown. The returned promise resolves only after `close`.
 */
export declare function keepHttpServerTaskAlive(params: {
    server: CloseAwareServer;
    abortSignal?: AbortSignal;
    onAbort?: () => void | Promise<void>;
}): Promise<void>;
export {};
