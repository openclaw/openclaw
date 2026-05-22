export type SessionLifecycleEvent = {
    sessionKey: string;
    reason: string;
    parentSessionKey?: string;
    label?: string;
    displayName?: string;
};
type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;
export declare function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void;
export declare function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void;
export {};
