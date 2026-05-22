export type CredsQueueWaitResult = "drained" | "timed_out";
export declare function writeWebCredsRawAtomically(params: {
    filePath: string;
    content: string;
    tempPrefix: string;
}): Promise<void>;
export declare function writeCredsJsonAtomically(authDir: string, creds: unknown): Promise<void>;
export declare function enqueueCredsSave(authDir: string, saveCreds: () => Promise<void> | void, onError: (error: unknown) => void): void;
export declare function waitForCredsSaveQueue(authDir?: string): Promise<void>;
export declare function waitForCredsSaveQueueWithTimeout(authDir: string, timeoutMs?: number): Promise<CredsQueueWaitResult>;
