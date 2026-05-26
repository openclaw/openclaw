export type DiagnosticTraceContext = {
    /** W3C trace id, 32 lowercase hex chars. */
    readonly traceId: string;
    /** Current span id, 16 lowercase hex chars. */
    readonly spanId?: string;
    /** Parent span id, 16 lowercase hex chars. */
    readonly parentSpanId?: string;
    /** W3C trace flags, 2 lowercase hex chars. Defaults to sampled. */
    readonly traceFlags?: string;
};
type DiagnosticTraceContextInput = Partial<DiagnosticTraceContext> & {
    traceparent?: string;
};
export declare function isValidDiagnosticTraceId(value: unknown): value is string;
export declare function isValidDiagnosticSpanId(value: unknown): value is string;
export declare function isValidDiagnosticTraceFlags(value: unknown): value is string;
export declare function parseDiagnosticTraceparent(traceparent: string | undefined): DiagnosticTraceContext | undefined;
export declare function formatDiagnosticTraceparent(context: DiagnosticTraceContext | undefined): string | undefined;
export declare function createDiagnosticTraceContext(input?: DiagnosticTraceContextInput): DiagnosticTraceContext;
export declare function createChildDiagnosticTraceContext(parent: DiagnosticTraceContext, input?: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent">): DiagnosticTraceContext;
export declare function createDiagnosticTraceContextFromActiveScope(input?: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent">): DiagnosticTraceContext;
export declare function freezeDiagnosticTraceContext(context: DiagnosticTraceContext): DiagnosticTraceContext;
export declare function getActiveDiagnosticTraceContext(): DiagnosticTraceContext | undefined;
export declare function runWithDiagnosticTraceContext<T>(trace: DiagnosticTraceContext, callback: () => T): T;
export declare function resetDiagnosticTraceContextForTest(): void;
export {};
