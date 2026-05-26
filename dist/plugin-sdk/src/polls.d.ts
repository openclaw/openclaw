export type PollInput = {
    question: string;
    options: string[];
    maxSelections?: number;
    /**
     * Poll duration in seconds.
     * Channel-specific limits apply in each owning plugin.
     */
    durationSeconds?: number;
    /**
     * Poll duration in hours.
     * Used by channels that model duration in hours.
     */
    durationHours?: number;
};
export type NormalizedPollInput = {
    question: string;
    options: string[];
    maxSelections: number;
    durationSeconds?: number;
    durationHours?: number;
};
type NormalizePollOptions = {
    maxOptions?: number;
};
export declare function resolvePollMaxSelections(optionCount: number, allowMultiselect: boolean | undefined): number;
export declare function normalizePollInput(input: PollInput, options?: NormalizePollOptions): NormalizedPollInput;
export declare function normalizePollDurationHours(value: number | undefined, options: {
    defaultHours: number;
    maxHours: number;
}): number;
export {};
