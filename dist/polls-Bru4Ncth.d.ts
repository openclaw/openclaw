//#region src/polls.d.ts
type PollInput = {
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
type NormalizedPollInput = {
  question: string;
  options: string[];
  maxSelections: number;
  durationSeconds?: number;
  durationHours?: number;
};
type NormalizePollOptions = {
  maxOptions?: number;
};
declare function resolvePollMaxSelections(optionCount: number, allowMultiselect: boolean | undefined): number;
declare function normalizePollInput(input: PollInput, options?: NormalizePollOptions): NormalizedPollInput;
declare function normalizePollDurationHours(value: number | undefined, options: {
  defaultHours: number;
  maxHours: number;
}): number;
//#endregion
export { resolvePollMaxSelections as a, normalizePollInput as i, PollInput as n, normalizePollDurationHours as r, NormalizedPollInput as t };