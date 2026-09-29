import { z } from "zod";

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const questionType = z.enum(["boolean", "choice", "score", "sort", "tags"]);
const questionTypes = z
  .array(questionType)
  .min(1)
  .max(5)
  .refine((values) => new Set(values).size === values.length);
const probabilitySemantics = z.enum(["boolean", "categorical", "independent", "none"]);
const question = z
  .object({
    /** Meaning of the supplied numbers, not a claim of calibrated accuracy. */
    probabilities: probabilitySemantics,
    /** The selected answer may be absent even when probabilities are present. */
    abstention: z.boolean(),
    minOptions: positiveInteger.optional(),
    maxOptions: positiveInteger.optional(),
    maxImageOptions: positiveInteger.optional(),
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
  })
  .refine((value) => Object.values(value).some(Boolean));
const reasoningMode = z.enum(["auto", "off", "on"]);
const reasoning = z
  .object({
    modes: z
      .array(reasoningMode)
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length),
    default: reasoningMode.optional(),
    questionTypes: questionTypes.optional(),
    /** Execution metadata is different from generated reasoning text. */
    metadata: z.boolean().optional(),
  })
  .refine((value) => value.default === undefined || value.modes.includes(value.default));
const billingSource = z.enum(["provider-docs", "provider-catalog", "configured"]);
const billing = z.discriminatedUnion("unit", [
  z.object({
    unit: z.literal("tokens"),
    source: billingSource,
    /** Omitted rates are unknown; explicit zero is a published free token bucket. */
    usdPerMillion: z
      .object({
        input: z.number().nonnegative().finite().optional(),
        output: z.number().nonnegative().finite().optional(),
      })
      .optional(),
  }),
  z.object({
    unit: z.enum(["decision-units", "requests"]),
    source: billingSource,
    // Token-shaped catalog pricing cannot silently become per-decision pricing.
    usdPerMillion: z.never().optional(),
  }),
]);

/** Provider-declared facts for one physical route; never execution or grounding authority. */
export const ModelInferenceCapabilitiesSchema = z.object({
  /** Explicit declarations never infer chat support from text encoding or structured output. */
  chat: z.boolean(),
  decision: z
    .object({
      /** Provider-owned wire adapter identifier, not an endpoint or credential identity. */
      protocol: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
      input: z
        .array(z.enum(["text", "image"]))
        .min(1)
        .max(2)
        .refine((values) => new Set(values).size === values.length),
      questions,
      reasoning: reasoning.optional(),
      /** Support only. A request still needs explicit shared policy for extra egress/billing. */
      grounding: z
        .object({
          webSearch: z.boolean(),
          questionTypes: questionTypes.optional(),
        })
        .optional(),
      limits: z
        .object({
          maxQuestions: positiveInteger.optional(),
          maxRequestTokens: positiveInteger.optional(),
          maxStateAndQuestionTokens: positiveInteger.optional(),
          maxInputTokens: positiveInteger.optional(),
          inputTokenScope: z.enum(["encoded-question", "state-plus-each-criterion"]).optional(),
          image: z
            .object({
              maxBytes: positiveInteger,
              mimeTypes: z
                .array(z.enum(["image/png", "image/jpeg", "image/webp"]))
                .min(1)
                .max(3),
              remoteUrls: z.boolean(),
            })
            .optional(),
        })
        .optional(),
      billing: billing.optional(),
    })
    .refine((value) => {
      const supported = (kind: z.infer<typeof questionType>) => value.questions[kind] !== undefined;
      return (
        (value.reasoning?.questionTypes?.every(supported) ?? true) &&
        (value.grounding?.questionTypes?.every(supported) ?? true) &&
        (value.limits?.image === undefined || value.input.includes("image"))
      );
    })
    .optional(),
});

/** Additive catalog metadata; the shipped conversational Model type remains unchanged. */
export type ModelInferenceCapabilities = z.infer<typeof ModelInferenceCapabilitiesSchema>;
export type ModelDecisionCapabilities = NonNullable<ModelInferenceCapabilities["decision"]>;
