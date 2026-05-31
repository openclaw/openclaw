//#region src/error-format.d.ts
declare function configureAcpErrorRedactor(redactor: ((value: string) => string) | undefined): void;
declare function redactSensitiveText(value: string): string;
/**
 * Render a non-Error `cause` value without leaking `[object Object]` or throwing
 * while formatting nested ACP runtime failures.
 */
declare function stringifyNonErrorCause(value: unknown): string;
//#endregion
export { configureAcpErrorRedactor, redactSensitiveText, stringifyNonErrorCause };