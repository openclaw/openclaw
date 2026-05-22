/**
 * Removes credential-like fields and image/base64 payload data from diagnostic
 * objects before persistence.
 */
export declare function sanitizeDiagnosticPayload(value: unknown): unknown;
