import { Type, type Static, type TSchema } from "typebox";

const MAX_CHOICE_OPTIONS = 255;
const MAX_SCORE_LEVELS = 10;

// Dynamic maps retain typed values for both schema validation and inferred types.
function map<T extends TSchema>(value: T, options: Record<string, unknown> = {}) {
  return Type.Unsafe<Record<string, Static<T>>>({
    type: "object",
    properties: {},
    additionalProperties: value,
    ...options,
  });
}

const entry = Type.Union(
  [Type.String(), map(Type.Unknown()), Type.Array(Type.Unknown()), Type.Null()],
  {
    description:
      "Text, a JSON object or array, or null. Nested values must be finite JSON. Use structure for rules, examples, and exclusions.",
  },
);
const instructions = Type.Optional(
  Type.Union(entry.anyOf, {
    description:
      "The complete judgment to make; question IDs are not read by the model. Text, structured object/array, or null. May be omitted when criteria express the judgment.",
  }),
);
const model = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9._/-]+$" });
const probability = Type.Number({ minimum: 0, maximum: 1 });
const objectOptions = { additionalProperties: false };
const noulQuestion = Type.Object(
  {
    type: Type.Literal("noul"),
    instructions,
    criteria: Type.Optional(
      Type.Union(
        [
          Type.Object({ true: Type.Optional(entry), false: Type.Optional(entry) }, objectOptions),
          Type.Null(),
        ],
        {
          description:
            "Optional true (yes) and false (no) outcome definitions; each accepts text, object, array, or null.",
        },
      ),
    ),
  },
  {
    ...objectOptions,
    description:
      "Probability of yes (0–1), not intensity; no separate confidence. Use separate Nouls for independent labels.",
  },
);
const choiceQuestion = Type.Object(
  {
    type: Type.Literal("choice"),
    instructions,
    criteria: map(entry, {
      minProperties: 2,
      maxProperties: MAX_CHOICE_OPTIONS,
      description:
        "2–255 competing labels mapped to descriptions. Labels may include spaces, punctuation, or Unicode. Null leaves a label undescribed. Include a no-match option when needed.",
    }),
  },
  {
    ...objectOptions,
    description:
      "Choose one alternative; returns its label, full probability distribution, and confidence.",
  },
);
const scoreQuestion = Type.Object(
  {
    type: Type.Literal("score"),
    instructions,
    criteria: Type.Array(entry, {
      minItems: 2,
      maxItems: MAX_SCORE_LEVELS,
      description:
        "2–10 ordered rubric levels, indexed from zero. Returns a fractional probability-weighted position, not an integer category or a normalized 0–1 score.",
    }),
  },
  objectOptions,
);
export const question = Type.Union([noulQuestion, choiceQuestion, scoreQuestion]);

/** Explicit shared state; independently evaluated questions never see other answers. */
export const EvaluateInput = Type.Object(
  {
    state: Type.Union(entry.anyOf, {
      description:
        "Shared evidence/context for every question. Only supplied state is sent; no ambient conversation is collected.",
    }),
    questions: map(question, {
      minProperties: 1,
      description:
        "Nonempty map of question IDs to Choice, Score, or Noul questions. Mix types in one call. IDs only match answers; put all meaning in instructions/criteria. Questions are independent. The server enforces token limits; plugin JSON guard is 4 MiB.",
    }),
    model: Type.Optional(
      Type.String({
        ...model,
        description:
          "Host-selected System One model ID or alias. A local Kev server uses its loaded checkpoint regardless of this label.",
      }),
    ),
  },
  objectOptions,
);
export type EvaluationInput = Static<typeof EvaluateInput>;

const distribution = map(probability, {
  minProperties: 2,
  maxProperties: MAX_CHOICE_OPTIONS,
});
const Answer = Type.Union([
  Type.Object({ type: Type.Literal("noul"), noul: probability }, objectOptions),
  Type.Object(
    {
      type: Type.Literal("choice"),
      choice: Type.String(),
      confidence: probability,
      probabilities: distribution,
    },
    objectOptions,
  ),
  Type.Object(
    {
      type: Type.Literal("score"),
      score: Type.Number({ minimum: 0, maximum: 9 }),
      confidence: probability,
      probabilities: distribution,
      legend: map(entry, {
        minProperties: 2,
        maxProperties: MAX_SCORE_LEVELS,
      }),
    },
    objectOptions,
  ),
]);
// System One implementations may add response/usage metadata; answers stay exact.
export const VendorResult = Type.Object(
  {
    model,
    answers: map(Answer, {
      minProperties: 1,
    }),
    usage: Type.Object(
      {
        input_tokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        output_tokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
export type Evaluation = Static<typeof VendorResult>;
