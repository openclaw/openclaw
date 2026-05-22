import { type DiagnosticPhaseDetails, type DiagnosticPhaseSnapshot } from "../infra/diagnostic-events.js";
export declare function getCurrentDiagnosticPhase(): string | undefined;
export declare function getRecentDiagnosticPhases(limit?: number): DiagnosticPhaseSnapshot[];
export declare function recordDiagnosticPhase(snapshot: DiagnosticPhaseSnapshot): void;
export declare function withDiagnosticPhase<T>(name: string, run: () => Promise<T> | T, details?: DiagnosticPhaseDetails): Promise<T>;
export declare function resetDiagnosticPhasesForTest(): void;
