/**
 * Check whether a session transcript file exists and contains at least one
 * assistant message, indicating that the SessionManager has flushed the
 * initial user+assistant exchange to disk.
 */
export declare function sessionFileHasContent(sessionFile: string | undefined): Promise<boolean>;
export declare function claudeCliSessionTranscriptHasContent(params: {
    sessionId: string | undefined;
    homeDir?: string;
}): Promise<boolean>;
export declare function resolveFallbackRetryPrompt(params: {
    body: string;
    isFallbackRetry: boolean;
    sessionHasHistory?: boolean;
}): string;
export declare function createAcpVisibleTextAccumulator(): {
    consume(chunk: string): {
        text: string;
        delta: string;
    } | null;
    finalize(): string;
    finalizeRaw(): string;
};
