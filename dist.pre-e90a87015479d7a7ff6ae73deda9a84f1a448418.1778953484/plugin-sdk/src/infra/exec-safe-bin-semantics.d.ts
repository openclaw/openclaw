type SafeBinSemanticValidationParams = {
    binName?: string;
    positional: readonly string[];
};
export declare function normalizeSafeBinName(raw: string): string;
export declare function validateSafeBinSemantics(params: SafeBinSemanticValidationParams): boolean;
export declare function listRiskyConfiguredSafeBins(entries: Iterable<string>): Array<{
    bin: string;
    warning: string;
}>;
export {};
