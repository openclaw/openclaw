type DiagnosticErrorFailureKind = "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
export declare function diagnosticErrorCategory(err: unknown): string;
export declare function diagnosticHttpStatusCode(err: unknown): string | undefined;
export declare function diagnosticErrorFailureKind(err: unknown): DiagnosticErrorFailureKind | undefined;
export declare function diagnosticProviderRequestIdHash(err: unknown): string | undefined;
export {};
