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
declare function getDefaultRedactPatterns(): string[];
declare function redactSensitiveLines(lines: string[], resolved: ResolvedRedactOptions): string[];
//#endregion
export { redactSensitiveLines as a, redactToolPayloadText as c, redactSensitiveFieldValue as i, resolveRedactOptions as l, ResolvedRedactOptions as n, redactSensitiveText as o, getDefaultRedactPatterns as r, redactToolDetail as s, RedactSensitiveMode as t };