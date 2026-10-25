import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { CronDateTimestampMsSchema } from "./cron-shared.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const AutomationMeaningfulOutcomeSchema = stringLiteralUnion([
  "progress",
  "done",
  "blocked",
  "needs_attention",
]);
export const AutomationOutcomeSchema = Type.Union([
  Type.Literal("no_change"),
  AutomationMeaningfulOutcomeSchema,
]);
export const AutomationResultSummarySchema = Type.String({
  minLength: 1,
  maxLength: 2000,
  pattern: "\\S",
});
export const AutomationMeaningfulResultSchema = closedObject({
  outcome: AutomationMeaningfulOutcomeSchema,
  summary: AutomationResultSummarySchema,
});
/** A quiet check needs no prose; meaningful facts always carry a bounded summary. */
export const AutomationResultSchema = Type.Union([
  closedObject({
    outcome: Type.Literal("no_change"),
    summary: Type.Optional(AutomationResultSummarySchema),
  }),
  AutomationMeaningfulResultSchema,
]);
export type AutomationResult = Static<typeof AutomationResultSchema>;
export const AutomationLastMeaningfulResultSchema = closedObject({
  ...AutomationMeaningfulResultSchema.properties,
  atMs: CronDateTimestampMsSchema,
});
