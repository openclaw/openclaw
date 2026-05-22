export type RequestCompactionInvocation = {
    sessionKey: string;
    sessionId: string;
    runId?: string;
    diagId: string;
    trigger: "volitional";
    reason: string;
    contextUsage: number;
    requestedAtMs: number;
    traceparent?: string;
};
export type CompactionCounterAttribution = {
    runId?: string;
    trigger: string;
    outcome: string;
};
export declare function createCompactionDiagId(now?: number): string;
export declare function normalizeCompactionTrigger(value: unknown): string;
