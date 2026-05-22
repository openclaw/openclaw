type OwnedSessionTranscriptWriteContext = {
    sessionFile?: string;
    sessionKey?: string;
    withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
};
export declare function withOwnedSessionTranscriptWrites<T>(context: OwnedSessionTranscriptWriteContext, run: () => Promise<T>): Promise<T>;
export declare function runWithOwnedSessionTranscriptWriteLock<T>(params: {
    sessionFile?: string;
    sessionKey?: string;
}, run: () => Promise<T> | T): Promise<T>;
export {};
