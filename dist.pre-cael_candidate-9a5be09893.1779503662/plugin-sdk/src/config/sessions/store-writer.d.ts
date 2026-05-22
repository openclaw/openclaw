export declare function withSessionStoreWriterForTest<T>(storePath: string, fn: () => Promise<T>): Promise<T>;
export declare function runExclusiveSessionStoreWrite<T>(storePath: string, fn: () => Promise<T>): Promise<T>;
