type Listener = (...args: unknown[]) => void;
type OffCapableEmitter = {
    on: (event: string, listener: Listener) => void;
    off?: (event: string, listener: Listener) => void;
    removeListener?: (event: string, listener: Listener) => void;
};
type ClosableSocket = {
    end?: (error: Error | undefined) => void;
    ws?: {
        close?: () => void;
    };
};
export declare function attachEmitterListener(emitter: OffCapableEmitter, event: string, listener: Listener): () => void;
export declare function closeInboundMonitorSocket(sock: ClosableSocket): void;
export {};
