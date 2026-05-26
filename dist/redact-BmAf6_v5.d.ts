//#region src/logging/redact.d.ts
type RedactSensitiveMode = "off" | "tools";
type RedactPattern = string | RegExp;
type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: RedactPattern[];
};
type ResolvedRedactOptions = {
  mode: RedactSensitiveMode;
  patterns: RegExp[];
};
declare function resolveRedactOptions(options?: RedactOptions): ResolvedRedactOptions;
declare function redactSensitiveText(text: string, options?: RedactOptions): string;
declare function redactToolDetail(detail: string): string;
declare function redactToolPayloadText(text: string): string;
declare function redactSensitiveFieldValue(key: string, value: string): string;
declare function redactSecrets<T>(value: T): T;
declare function getDefaultRedactPatterns(): string[];
declare function redactSensitiveLines(lines: string[], resolved: ResolvedRedactOptions): string[];
//#endregion
export { redactSensitiveFieldValue as a, redactToolDetail as c, redactSecrets as i, redactToolPayloadText as l, ResolvedRedactOptions as n, redactSensitiveLines as o, getDefaultRedactPatterns as r, redactSensitiveText as s, RedactSensitiveMode as t, resolveRedactOptions as u };