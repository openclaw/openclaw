export type RedactSensitiveMode = "off" | "tools";
type RedactOptions = {
    mode?: RedactSensitiveMode;
    patterns?: string[];
};
export declare function redactSensitiveText(text: string, options?: RedactOptions): string;
export declare function redactToolDetail(detail: string): string;
export declare function getDefaultRedactPatterns(): string[];
export {};
