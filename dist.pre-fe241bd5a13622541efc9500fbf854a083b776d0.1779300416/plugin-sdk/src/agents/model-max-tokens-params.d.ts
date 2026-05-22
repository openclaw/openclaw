export declare function resolveNonNegativeMaxTokensParam(value: unknown): number | undefined;
export declare function resolveMaxTokensParam(params: Record<string, unknown> | undefined): number | undefined;
export declare function canonicalizeMaxTokensParam(params: {
    merged: Record<string, unknown>;
    sources: Array<Record<string, unknown> | undefined>;
}): void;
