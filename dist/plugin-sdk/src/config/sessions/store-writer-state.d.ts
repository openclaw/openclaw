export type SessionStoreWriterTask = {
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
};
export type SessionStoreWriterQueue = {
    running: boolean;
    pending: SessionStoreWriterTask[];
    drainPromise: Promise<void> | null;
};
export declare const WRITER_QUEUES: Map<string, SessionStoreWriterQueue>;
export declare function clearSessionStoreCacheForTest(): void;
export declare function drainSessionStoreWriterQueuesForTest(): Promise<void>;
export declare function getSessionStoreWriterQueueSizeForTest(): number;
