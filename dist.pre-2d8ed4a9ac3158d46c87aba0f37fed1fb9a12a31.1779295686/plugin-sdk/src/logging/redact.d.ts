import type { OpenClawConfig } from "../config/types.openclaw.js";
export type RedactSensitiveMode = "off" | "tools";
export type RedactPattern = string | RegExp;
type LoggingConfig = OpenClawConfig["logging"];
export type RedactOptions = {
    mode?: RedactSensitiveMode;
    patterns?: RedactPattern[];
};
export type ResolvedRedactOptions = {
    mode: RedactSensitiveMode;
    patterns: RegExp[];
};
export declare function resolveRedactOptions(options?: RedactOptions): ResolvedRedactOptions;
export declare function redactSensitiveText(text: string, options?: RedactOptions): string;
export declare function redactToolDetail(detail: string): string;
export declare function redactToolPayloadText(text: string): string;
export declare function redactToolPayloadTextWithConfig(text: string, loggingConfig?: LoggingConfig): string;
export declare function isSensitiveFieldKey(key: string): boolean;
export declare function redactSensitiveFieldValue(key: string, value: string, options?: RedactOptions): string;
export declare function redactSensitiveFieldValueWithConfig(key: string, value: string, loggingConfig?: LoggingConfig): string;
export declare function redactSecrets<T>(value: T): T;
export declare function getDefaultRedactPatterns(): string[];
export declare function redactSensitiveLines(lines: string[], resolved: ResolvedRedactOptions): string[];
export {};
