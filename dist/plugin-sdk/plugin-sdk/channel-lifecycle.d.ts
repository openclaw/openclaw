import type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";
type CloseAwareServer = {
    once: (event: "close", listener: () => void) => unknown;
};
type PassiveAccountLifecycleParams<Handle> = {
    abortSignal?: AbortSignal;
    start: () => Promise<Handle>;
    stop?: (handle: Handle) => void | Promise<void>;
    onStop?: () => void | Promise<void>;
};
export declare function createAccountStatusSink(params: {
    accountId: string;
    setStatus: (next: ChannelAccountSnapshot) => void;
}): (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
/**
 * Return a promise that resolves when the signal is aborted.
 *
 * If no signal is provided, the promise stays pending forever. When provided,
 * `onAbort` runs once before the promise resolves.
 */
export declare function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void | Promise<void>): Promise<void>;
/**
 * Keep a passive account task alive until abort, then run optional cleanup.
 */
export declare function runPassiveAccountLifecycle<Handle>(params: PassiveAccountLifecycleParams<Handle>): Promise<void>;
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
