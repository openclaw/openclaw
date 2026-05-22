type OwnedSessionTranscriptWriteContext = {
    sessionFile?: string;
    sessionKey?: string;
    withSessionWriteLock: <T>(run: () => Promise<T> | T, options?: {
        publishOwnedWrite?: boolean;
    }) => Promise<T>;
};
export declare function withOwnedSessionTranscriptWrites<T>(context: OwnedSessionTranscriptWriteContext, run: () => Promise<T>): Promise<T>;
export declare function bindOwnedSessionTranscriptWrites<TArgs extends unknown[], TResult>(context: OwnedSessionTranscriptWriteContext, run: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
export declare function runWithOwnedSessionTranscriptWriteLock<T>(params: {
    sessionFile?: string;
    sessionKey?: string;
}, run: () => Promise<T> | T): Promise<T>;
export declare function runWithOwnedSessionTranscriptWritePublication<T>(params: {
    sessionFile?: string;
    sessionKey?: string;
}, run: () => Promise<T> | T): Promise<T>;
export declare function resolveOwnedSessionTranscriptWriteLockRunner(params: {
    sessionFile?: string;
    sessionKey?: string;
}): OwnedSessionTranscriptWriteContext["withSessionWriteLock"] | undefined;
export {};
