import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type DiagnosticLivenessWarningReason } from "../infra/diagnostic-events.js";
import { emitDiagnosticMemorySample } from "./diagnostic-memory.js";
import { type SessionAttentionClassification } from "./diagnostic-session-attention.js";
import { type RecoverStuckSession } from "./diagnostic-session-recovery-coordinator.js";
import { type SessionRef, type SessionStateValue } from "./diagnostic-session-state.js";
export { diagnosticLogger, logLaneDequeue, logLaneEnqueue } from "./diagnostic-runtime.js";
type EmitDiagnosticMemorySample = typeof emitDiagnosticMemorySample;
type DiagnosticWorkSnapshot = {
    activeCount: number;
    waitingCount: number;
    queuedCount: number;
    activeLabels: string[];
    waitingLabels: string[];
    queuedLabels: string[];
};
type DiagnosticLivenessSample = {
    reasons: DiagnosticLivenessWarningReason[];
    intervalMs: number;
    eventLoopDelayP99Ms?: number;
    eventLoopDelayMaxMs?: number;
    eventLoopUtilization?: number;
    cpuUserMs?: number;
    cpuSystemMs?: number;
    cpuTotalMs?: number;
    cpuCoreRatio?: number;
};
type SampleDiagnosticLiveness = (now: number, work: DiagnosticWorkSnapshot) => DiagnosticLivenessSample | null;
type StartDiagnosticHeartbeatOptions = {
    getConfig?: () => OpenClawConfig;
    emitMemorySample?: EmitDiagnosticMemorySample;
    sampleLiveness?: SampleDiagnosticLiveness;
    recoverStuckSession?: RecoverStuckSession;
    startupGraceMs?: number;
};
export declare function resolveStuckSessionWarnMs(config?: OpenClawConfig): number;
export declare function resolveStuckSessionAbortMs(config: OpenClawConfig | undefined, stuckSessionWarnMs: number): number;
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
export declare function logMessageReceived(params: {
    sessionId?: string;
    sessionKey?: string;
    channel?: string;
    messageId?: number | string;
    chatId?: number | string;
    source: string;
}): void;
export declare function logMessageDispatchStarted(params: {
    sessionId?: string;
    sessionKey?: string;
    channel?: string;
    source: string;
}): void;
export declare function logMessageDispatchCompleted(params: {
    sessionId?: string;
    sessionKey?: string;
    channel?: string;
    source: string;
    durationMs: number;
    outcome: "completed" | "skipped" | "error";
    reason?: string;
    error?: string;
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
export declare function logSessionTurnCreated(params: {
    runId: string;
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
    channel?: string;
    trigger: "user" | "heartbeat";
}): void;
export declare function logSessionStateChange(params: SessionRef & {
    state: SessionStateValue;
    reason?: string;
}): void;
export declare function markDiagnosticSessionProgress(params: SessionRef): void;
export declare function logSessionAttention(params: SessionRef & {
    state: SessionStateValue;
    ageMs: number;
    thresholdMs: number;
    abortThresholdMs?: number;
}): SessionAttentionClassification | undefined;
export declare function logRunAttempt(params: SessionRef & {
    runId: string;
    attempt: number;
}): void;
export declare function logToolLoopAction(params: SessionRef & {
    toolName: string;
    level: "warning" | "critical";
    action: "warn" | "block";
    detector: "generic_repeat" | "unknown_tool_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
    count: number;
    message: string;
    pairedToolName?: string;
}): void;
export declare function logActiveRuns(): void;
export declare function startDiagnosticHeartbeat(config?: OpenClawConfig, opts?: StartDiagnosticHeartbeatOptions): void;
export declare function stopDiagnosticHeartbeat(): void;
export declare function getDiagnosticSessionStateCountForTest(): number;
export declare function resetDiagnosticStateForTest(): void;
