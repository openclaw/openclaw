import type { DiagnosticSessionActiveWorkKind, DiagnosticSessionState } from "../infra/diagnostic-events.js";
export type DiagnosticSessionRecoveryStatus = "aborted" | "released" | "skipped" | "noop" | "failed";
export type DiagnosticSessionRecoverySkipReason = "active_embedded_run" | "active_reply_work" | "active_lane_task" | "already_in_flight" | "missing_session_ref" | "stale_session_state";
export type DiagnosticSessionRecoveryNoopReason = "no_active_work";
export type StuckSessionRecoveryRequest = {
    sessionId?: string;
    sessionKey?: string;
    ageMs: number;
    queueDepth?: number;
    allowActiveAbort?: boolean;
    expectedState?: DiagnosticSessionState;
    stateGeneration?: number;
};
type DiagnosticSessionRecoveryBaseOutcome = {
    sessionId?: string;
    sessionKey?: string;
    activeSessionId?: string;
    lane?: string;
    activeWorkKind?: DiagnosticSessionActiveWorkKind;
};
export type StuckSessionRecoveryOutcome = (DiagnosticSessionRecoveryBaseOutcome & {
    status: "aborted";
    action: "abort_embedded_run";
    aborted: boolean;
    drained: boolean;
    forceCleared: boolean;
    released: number;
    queuedCount?: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
    status: "released";
    action: "release_lane";
    released: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
    status: "skipped";
    action: "observe_only" | "keep_lane";
    reason: DiagnosticSessionRecoverySkipReason;
    activeCount?: number;
    queuedCount?: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
    status: "noop";
    action: "none";
    reason: DiagnosticSessionRecoveryNoopReason;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
    status: "failed";
    action: "none";
    reason: "exception";
    error: string;
});
export declare function recoveryOutcomeMutatesSessionState(outcome: StuckSessionRecoveryOutcome | undefined): boolean;
export declare function recoveryOutcomeClearsQueuedSessionState(outcome: StuckSessionRecoveryOutcome): boolean;
export declare function recoveryOutcomeReleasedCount(outcome: StuckSessionRecoveryOutcome): number;
export declare function formatRecoveryOutcome(outcome: StuckSessionRecoveryOutcome): string;
export {};
