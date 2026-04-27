export declare const REDACTED_IMAGE_DATA = "<redacted>";
/**
 * Removes credential-like fields and image/base64 payload data from diagnostic
 * objects before persistence.
 */
export declare function sanitizeDiagnosticPayload(value: unknown): unknown;
