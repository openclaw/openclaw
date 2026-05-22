//#region src/infra/diagnostic-trace-context-pure.d.ts
type DiagnosticTraceContext = {
  /** W3C trace id, 32 lowercase hex chars. */readonly traceId: string; /** Current span id, 16 lowercase hex chars. */
  readonly spanId?: string; /** Parent span id, 16 lowercase hex chars. */
  readonly parentSpanId?: string; /** W3C trace flags, 2 lowercase hex chars. Defaults to sampled. */
  readonly traceFlags?: string;
};
declare function isValidDiagnosticTraceId(value: unknown): value is string;
declare function isValidDiagnosticSpanId(value: unknown): value is string;
declare function isValidDiagnosticTraceFlags(value: unknown): value is string;
declare function parseDiagnosticTraceparent(traceparent: string | undefined): DiagnosticTraceContext | undefined;
//#endregion
//#region src/infra/diagnostic-trace-context.d.ts
type DiagnosticTraceContextInput = Partial<DiagnosticTraceContext> & {
  traceparent?: string;
};
declare function formatDiagnosticTraceparent(context: DiagnosticTraceContext | undefined): string | undefined;
declare function createDiagnosticTraceContext(input?: DiagnosticTraceContextInput): DiagnosticTraceContext;
declare function createChildDiagnosticTraceContext(parent: DiagnosticTraceContext, input?: Omit<DiagnosticTraceContextInput, "traceId" | "traceparent">): DiagnosticTraceContext;
//#endregion
export { isValidDiagnosticSpanId as a, parseDiagnosticTraceparent as c, DiagnosticTraceContext as i, createDiagnosticTraceContext as n, isValidDiagnosticTraceFlags as o, formatDiagnosticTraceparent as r, isValidDiagnosticTraceId as s, createChildDiagnosticTraceContext as t };