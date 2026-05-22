import { DIAGNOSTIC_TRACEPARENT_PATTERN, isValidDiagnosticSpanId, isValidDiagnosticTraceFlags, isValidDiagnosticTraceId, normalizeDiagnosticTraceparent, parseDiagnosticTraceparent } from "./diagnostic-trace-context-pure.js";
import type { DiagnosticTraceContext } from "./diagnostic-trace-context-pure.js";
export { DIAGNOSTIC_TRACEPARENT_PATTERN, isValidDiagnosticSpanId, isValidDiagnosticTraceFlags, isValidDiagnosticTraceId, normalizeDiagnosticTraceparent, parseDiagnosticTraceparent, };
export type { DiagnosticTraceContext };
type DiagnosticTraceContextInput = Partial<DiagnosticTraceContext> & {
    traceparent?: string;
};
export declare function formatDiagnosticTraceparent(context: DiagnosticTraceContext | undefined): string | undefined;
export declare function createDiagnosticTraceContext(input?: DiagnosticTraceContextInput): DiagnosticTraceContext;
export declare function createChildDiagnosticTraceContext(parent: DiagnosticTraceContext, input?: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent">): DiagnosticTraceContext;
export declare function createDiagnosticTraceContextFromActiveScope(input?: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent">): DiagnosticTraceContext;
export declare function freezeDiagnosticTraceContext(context: DiagnosticTraceContext): DiagnosticTraceContext;
export declare function getActiveDiagnosticTraceContext(): DiagnosticTraceContext | undefined;
export declare function runWithDiagnosticTraceContext<T>(trace: DiagnosticTraceContext, callback: () => T): T;
export declare function resetDiagnosticTraceContextForTest(): void;
