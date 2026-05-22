export declare function readLatestSubagentOutputWithRetryUsing<Outcome = unknown>(params: {
    sessionKey: string;
    maxWaitMs: number;
    retryIntervalMs: number;
    outcome?: Outcome;
    readSubagentOutput: (sessionKey: string, outcome?: Outcome) => Promise<string | undefined>;
}): Promise<string | undefined>;
export declare function captureSubagentCompletionReplyUsing(params: {
    sessionKey: string;
    waitForReply?: boolean;
    maxWaitMs: number;
    retryIntervalMs: number;
    readSubagentOutput: (sessionKey: string) => Promise<string | undefined>;
}): Promise<string | undefined>;
