export type SessionStateValue = "idle" | "processing" | "waiting";
export type SessionState = {
    sessionId?: string;
    sessionKey?: string;
    lastActivity: number;
    generation?: number;
    lastStuckWarnAgeMs?: number;
    lastLongRunningWarnAgeMs?: number;
    state: SessionStateValue;
    queueDepth: number;
    activeQueuedTurn?: boolean;
    toolCallHistory?: ToolCallRecord[];
    toolLoopWarningBuckets?: Map<string, number>;
    commandPollCounts?: Map<string, {
        count: number;
        lastPollAt: number;
    }>;
};
export type ToolCallRecord = {
    toolName: string;
    argsHash: string;
    toolCallId?: string;
    runId?: string;
    resultHash?: string;
    unknownToolName?: string;
    timestamp: number;
};
export type SessionRef = {
    sessionId?: string;
    sessionKey?: string;
};
export declare const diagnosticSessionStates: Map<string, SessionState>;
export declare function pruneDiagnosticSessionStates(now?: number, force?: boolean): void;
export declare function getDiagnosticSessionState(ref: SessionRef): SessionState;
export declare function peekDiagnosticSessionState(ref: SessionRef): SessionState | undefined;
export declare function getDiagnosticSessionStateCountForTest(): number;
export declare function resetDiagnosticSessionStateForTest(): void;
export declare function isDiagnosticSessionStateCurrent(params: {
    sessionId?: string;
    sessionKey?: string;
    generation?: number;
    state?: SessionStateValue;
}): boolean;
