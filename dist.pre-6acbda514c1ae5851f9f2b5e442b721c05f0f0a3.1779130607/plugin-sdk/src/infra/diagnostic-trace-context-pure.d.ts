export declare const TRACEPARENT_VERSION = "00";
export declare const DIAGNOSTIC_TRACEPARENT_PATTERN = "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$";
export type DiagnosticTraceContext = {
    /** W3C trace id, 32 lowercase hex chars. */
    readonly traceId: string;
    /** Current span id, 16 lowercase hex chars. */
    readonly spanId?: string;
    /** Parent span id, 16 lowercase hex chars. */
    readonly parentSpanId?: string;
    /** W3C trace flags, 2 lowercase hex chars. Defaults to sampled. */
    readonly traceFlags?: string;
    /** Marks a current span id parsed from a remote W3C traceparent. */
    readonly spanIdSource?: "remote";
    /** Marks a parent span id inherited from a remote W3C traceparent. */
    readonly parentSpanIdSource?: "remote";
};
export declare function isValidDiagnosticTraceId(value: unknown): value is string;
export declare function isValidDiagnosticSpanId(value: unknown): value is string;
export declare function isValidDiagnosticTraceFlags(value: unknown): value is string;
export declare function normalizeTraceId(value: unknown): string | undefined;
export declare function normalizeSpanId(value: unknown): string | undefined;
export declare function normalizeTraceFlags(value: unknown): string | undefined;
export declare function parseDiagnosticTraceparent(traceparent: string | undefined): DiagnosticTraceContext | undefined;
export declare function normalizeDiagnosticTraceparent(traceparent: string | undefined): string | undefined;
