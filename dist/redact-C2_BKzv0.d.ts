import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/logging/redact.d.ts
type RedactSensitiveMode = "off" | "tools";
type RedactPattern = string | RegExp;
type LoggingConfig = OpenClawConfig["logging"];
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
declare function redactToolPayloadTextWithConfig(text: string, loggingConfig?: LoggingConfig): string;
declare function isSensitiveFieldKey(key: string): boolean;
declare function redactSensitiveFieldValue(key: string, value: string, options?: RedactOptions): string;
declare function redactSensitiveFieldValueWithConfig(key: string, value: string, loggingConfig?: LoggingConfig): string;
declare function redactSecrets<T>(value: T): T;
declare function getDefaultRedactPatterns(): string[];
declare function redactSensitiveLines(lines: string[], resolved: ResolvedRedactOptions): string[];
//#endregion
export { getDefaultRedactPatterns as a, redactSensitiveFieldValue as c, redactSensitiveText as d, redactToolDetail as f, resolveRedactOptions as h, ResolvedRedactOptions as i, redactSensitiveFieldValueWithConfig as l, redactToolPayloadTextWithConfig as m, RedactPattern as n, isSensitiveFieldKey as o, redactToolPayloadText as p, RedactSensitiveMode as r, redactSecrets as s, RedactOptions as t, redactSensitiveLines as u };