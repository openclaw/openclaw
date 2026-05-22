export type RedactSensitiveMode = "off" | "tools";
type RedactPattern = string | RegExp;
type RedactOptions = {
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
export declare function redactSensitiveFieldValue(key: string, value: string): string;
export declare function getDefaultRedactPatterns(): string[];
export declare function redactSensitiveLines(lines: string[], resolved: ResolvedRedactOptions): string[];
export {};
