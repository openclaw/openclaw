import type { DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";
import type { DiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";
export type SessionAttentionClassification = {
    eventType: "session.long_running";
    reason: string;
    classification: "long_running";
    activeWorkKind?: DiagnosticSessionActiveWorkKind;
    recoveryEligible: false;
} | {
    eventType: "session.stalled";
    reason: string;
    classification: "blocked_tool_call" | "stalled_agent_run";
    activeWorkKind?: DiagnosticSessionActiveWorkKind;
    recoveryEligible: false;
} | {
    eventType: "session.stuck";
    reason: string;
    classification: "stale_session_state";
    activeWorkKind?: undefined;
    recoveryEligible: true;
};
export declare function classifySessionAttention(params: {
    queueDepth: number;
    activity: DiagnosticSessionActivitySnapshot;
    staleMs: number;
}): SessionAttentionClassification;
