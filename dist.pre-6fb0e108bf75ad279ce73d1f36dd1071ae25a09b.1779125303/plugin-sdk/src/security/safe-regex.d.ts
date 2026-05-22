export type SafeRegexRejectReason = "empty" | "unsafe-nested-repetition" | "invalid-regex";
export type SafeRegexCompileResult = {
    regex: RegExp;
    source: string;
    flags: string;
    reason: null;
} | {
    regex: null;
    source: string;
    flags: string;
    reason: SafeRegexRejectReason;
};
export declare function testRegexWithBoundedInput(regex: RegExp, input: string, maxWindow?: number): boolean;
export declare function hasNestedRepetition(source: string): boolean;
export declare function compileSafeRegexDetailed(source: string, flags?: string): SafeRegexCompileResult;
export declare function compileSafeRegex(source: string, flags?: string): RegExp | null;
