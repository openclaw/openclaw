import { type SessionRef, type SessionStateValue } from "./diagnostic-session-state.js";
declare const diag: import("./subsystem.js").SubsystemLogger;
export declare function logWebhookReceived(params: {
    channel: string;
    updateType?: string;
    chatId?: number | string;
}): void;
export declare function logWebhookProcessed(params: {
    channel: string;
    updateType?: string;
    chatId?: number | string;
    durationMs?: number;
}): void;
export declare function logWebhookError(params: {
    channel: string;
    updateType?: string;
    chatId?: number | string;
    error: string;
}): void;
export declare function logMessageQueued(params: {
    sessionId?: string;
    sessionKey?: string;
    channel?: string;
    source: string;
}): void;
export declare function logMessageProcessed(params: {
    channel: string;
    messageId?: number | string;
    chatId?: number | string;
    sessionId?: string;
    sessionKey?: string;
    durationMs?: number;
    outcome: "completed" | "skipped" | "error";
    reason?: string;
    error?: string;
}): void;
export declare function logSessionStateChange(params: SessionRef & {
    state: SessionStateValue;
    reason?: string;
}): void;
export declare function logSessionStuck(params: SessionRef & {
    state: SessionStateValue;
    ageMs: number;
}): void;
export declare function logLaneEnqueue(lane: string, queueSize: number): void;
export declare function logLaneDequeue(lane: string, waitMs: number, queueSize: number): void;
export declare function logRunAttempt(params: SessionRef & {
    runId: string;
    attempt: number;
}): void;
export declare function logToolLoopAction(params: SessionRef & {
    toolName: string;
    level: "warning" | "critical";
    action: "warn" | "block";
    detector: "generic_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
    count: number;
    message: string;
    pairedToolName?: string;
}): void;
export declare function logActiveRuns(): void;
export declare function startDiagnosticHeartbeat(): void;
export declare function stopDiagnosticHeartbeat(): void;
export declare function getDiagnosticSessionStateCountForTest(): number;
export declare function resetDiagnosticStateForTest(): void;
export { diag as diagnosticLogger };
