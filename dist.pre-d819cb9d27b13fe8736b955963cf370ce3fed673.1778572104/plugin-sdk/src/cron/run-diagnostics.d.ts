import type { CronRunDiagnostics, CronRunDiagnosticSeverity, CronRunDiagnosticSource } from "./types.js";
export declare function summarizeCronRunDiagnostics(diagnostics: CronRunDiagnostics | undefined): string | undefined;
export declare function normalizeCronRunDiagnostics(value: unknown, opts?: {
    nowMs?: () => number;
}): CronRunDiagnostics | undefined;
export declare function mergeCronRunDiagnostics(...values: Array<CronRunDiagnostics | undefined>): CronRunDiagnostics | undefined;
export declare function createCronRunDiagnosticsFromError(source: CronRunDiagnosticSource, error: unknown, opts?: {
    severity?: CronRunDiagnosticSeverity;
    nowMs?: () => number;
    toolName?: string;
    exitCode?: number | null;
}): CronRunDiagnostics | undefined;
export declare function createCronRunDiagnosticsFromExecDetails(details: unknown, opts?: {
    nowMs?: () => number;
    toolName?: string;
}): CronRunDiagnostics | undefined;
export declare function createCronRunDiagnosticsFromToolPayload(payload: unknown, opts?: {
    nowMs?: () => number;
    finalStatus?: "ok" | "error" | "skipped";
}): CronRunDiagnostics | undefined;
export declare function createCronRunDiagnosticsFromAgentResult(result: unknown, opts?: {
    nowMs?: () => number;
    finalStatus?: "ok" | "error" | "skipped";
}): CronRunDiagnostics | undefined;
