export type PollInput = {
    question: string;
    options: string[];
    maxSelections?: number;
    /**
     * Poll duration in seconds.
     * Channel-specific limits apply (e.g. Telegram open_period is 5-600s).
     */
    durationSeconds?: number;
    /**
     * Poll duration in hours.
     * Used by channels that model duration in hours (e.g. Discord).
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
export declare function normalizePollInput(input: PollInput, options?: NormalizePollOptions): NormalizedPollInput;
export declare function normalizePollDurationHours(value: number | undefined, options: {
    defaultHours: number;
    maxHours: number;
}): number;
export {};
