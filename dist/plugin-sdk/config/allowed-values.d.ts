export type AllowedValuesSummary = {
    values: string[];
    hiddenCount: number;
    formatted: string;
};
export declare function summarizeAllowedValues(values: ReadonlyArray<unknown>): AllowedValuesSummary | null;
export declare function appendAllowedValuesHint(message: string, summary: AllowedValuesSummary): string;
