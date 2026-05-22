//#region src/logging/redact-identifier.d.ts
declare function sha256HexPrefix(value: string, len?: number): string;
declare function redactIdentifier(value: string | undefined, opts?: {
  len?: number;
}): string;
//#endregion
export { sha256HexPrefix as n, redactIdentifier as t };