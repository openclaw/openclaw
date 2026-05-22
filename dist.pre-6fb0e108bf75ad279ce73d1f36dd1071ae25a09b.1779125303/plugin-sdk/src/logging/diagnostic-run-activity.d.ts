import { type DiagnosticEventPayload, type DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";
type DiagnosticModelStartedActivityEvent = Pick<Extract<DiagnosticEventPayload, {
    type: "model.call.started";
}>, "runId" | "sessionId" | "sessionKey" | "provider" | "model">;
export type DiagnosticSessionActivitySnapshot = {
    activeWorkKind?: DiagnosticSessionActiveWorkKind;
    hasActiveEmbeddedRun?: boolean;
    activeToolName?: string;
    activeToolCallId?: string;
    activeToolAgeMs?: number;
    lastProgressAgeMs?: number;
    lastProgressReason?: string;
};
export declare function markDiagnosticEmbeddedRunStarted(params: {
    sessionId: string;
    sessionKey?: string;
    workKey?: string;
}): void;
export declare function markDiagnosticEmbeddedRunEnded(params: {
    sessionId: string;
    sessionKey?: string;
    workKey?: string;
    clearRunActivity?: boolean;
}): void;
export declare function getDiagnosticSessionActivitySnapshot(params: {
    sessionId?: string;
    sessionKey?: string;
}, now?: number): DiagnosticSessionActivitySnapshot;
export declare function markDiagnosticRunProgressForTest(params: {
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    reason: string;
}): void;
export declare function markDiagnosticToolStartedForTest(params: {
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    toolName: string;
    toolCallId?: string;
}): void;
export declare function markDiagnosticModelStartedForTest(params: DiagnosticModelStartedActivityEvent): void;
export declare function resetDiagnosticRunActivityForTest(): void;
export {};
