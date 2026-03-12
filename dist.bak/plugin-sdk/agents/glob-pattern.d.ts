export type CompiledGlobPattern = {
    kind: "all";
} | {
    kind: "exact";
    value: string;
} | {
    kind: "regex";
    value: RegExp;
};
export declare function compileGlobPattern(params: {
    raw: string;
    normalize: (value: string) => string;
}): CompiledGlobPattern;
export declare function compileGlobPatterns(params: {
    raw?: string[] | undefined;
    normalize: (value: string) => string;
}): CompiledGlobPattern[];
export declare function matchesAnyGlobPattern(value: string, patterns: CompiledGlobPattern[]): boolean;
