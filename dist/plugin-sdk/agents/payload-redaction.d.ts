export declare const REDACTED_IMAGE_DATA = "<redacted>";
/**
 * Redacts image/base64 payload data from diagnostic objects before persistence.
 */
export declare function redactImageDataForDiagnostics(value: unknown): unknown;
