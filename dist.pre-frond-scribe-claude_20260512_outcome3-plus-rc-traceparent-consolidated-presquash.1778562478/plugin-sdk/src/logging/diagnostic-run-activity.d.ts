import { type DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";
export type DiagnosticSessionActivitySnapshot = {
    activeWorkKind?: DiagnosticSessionActiveWorkKind;
    activeToolName?: string;
    activeToolCallId?: string;
    activeToolAgeMs?: number;
    lastProgressAgeMs?: number;
    lastProgressReason?: string;
};
export declare function markDiagnosticEmbeddedRunStarted(params: {
    sessionId: string;
    sessionKey?: string;
}): void;
export declare function markDiagnosticEmbeddedRunEnded(params: {
    sessionId: string;
    sessionKey?: string;
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
export declare function resetDiagnosticRunActivityForTest(): void;
