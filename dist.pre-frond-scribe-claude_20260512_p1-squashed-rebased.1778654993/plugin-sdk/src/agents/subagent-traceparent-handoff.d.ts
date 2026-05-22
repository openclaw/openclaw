export type SubagentTraceparentHandoff = {
    idempotencyKey: string;
    sessionKey: string;
    traceparent: string;
};
export declare function registerSubagentTraceparentHandoff(params: {
    idempotencyKey: string;
    sessionKey: string;
    traceparent?: string;
    nowMs?: number;
}): SubagentTraceparentHandoff | undefined;
export declare function consumeSubagentTraceparentHandoff(params: {
    idempotencyKey?: string;
    sessionKey?: string;
    nowMs?: number;
}): SubagentTraceparentHandoff | undefined;
export declare function resetSubagentTraceparentHandoffsForTests(): void;
