import { z } from "zod";

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const probabilitySemantics = z.enum([
  "boolean",
  "categorical",
  "independent",
  "provider-defined",
  "none",
]);
const question = z
  .object({
    /** Meaning of the supplied numbers, not a claim of calibrated accuracy. */
    probabilities: probabilitySemantics,
    /** The selected answer may be absent even when probabilities are present. */
    abstention: z.boolean(),
    minOptions: positiveInteger.optional(),
    maxOptions: positiveInteger.optional(),
    maxImageOptions: positiveInteger.optional(),
    requiresCriteria: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.minOptions === undefined ||
      value.maxOptions === undefined ||
      value.minOptions <= value.maxOptions,
  );
const questions = z
  .object({
    boolean: question.optional(),
    choice: question.optional(),
    score: question.optional(),
    sort: question.optional(),
    tags: question.optional(),
    box: question.optional(),
  })
  .refine((value) => Object.values(value).some(Boolean));

/** Answer interpretation without route, credentials, execution or billing metadata. */
export const DecisionAnswerCapabilitiesSchema = z.object({
  /** Absent means undeclared kinds/semantics, not an invented support claim. */
  questions: questions.optional(),
  confidence: z.enum(["provider-specific", "none"]).optional(),
});

export type DecisionAnswerCapabilities = z.infer<typeof DecisionAnswerCapabilitiesSchema>;
