import { isDeepStrictEqual } from "node:util";
import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Check } from "typebox/value";

// Transport/CPU guards, not Jev token limits. Jev enforces its own context budget.
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_JSON_NODES = 262144;
const MAX_JSON_DEPTH = 64;
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

// Use additionalProperties, not patternProperties: tool declaration renderers can
// expose the value type as an index signature rather than erasing it to {}.
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
      "The complete judgment to make; question IDs are not read by Jev. Text, structured object/array, or null. May be omitted when criteria express the judgment.",
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
const question = Type.Union([noulQuestion, choiceQuestion, scoreQuestion]);

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
        "Nonempty map of question IDs to Choice, Score, or Noul questions. Mix types in one call. IDs only match answers; put all meaning in instructions/criteria. Questions are independent. Jev enforces token limits; plugin JSON guard is 4 MiB.",
    }),
    model: Type.Optional(
      Type.String({
        ...model,
        description:
          "Optional Jev model ID or alias for this explicit tool call; defaults to the plugin’s evaluation-tool model. Native decisions use the host-selected model.",
      }),
    ),
  },
  objectOptions,
);
export type EvaluationInput = Static<typeof EvaluateInput>;
const inputValidator = Compile(EvaluateInput);

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
const VendorResult = Type.Object(
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
      objectOptions,
    ),
  },
  objectOptions,
);
export const EvaluateOutput = Type.Object({ evaluation: VendorResult }, objectOptions);
export type Evaluation = Static<typeof VendorResult>;
const resultValidator = Compile(VendorResult);

/** Reject non-JSON values and excessive structure before schema walking or serialization. */
function assertBoundedJson(value: unknown): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error("TypeSafe JSON exceeds resource limits (262144 nodes or depth 64).");
    }
    if (node === null || typeof node === "string" || typeof node === "boolean") {
      return;
    }
    if (typeof node === "number" && Number.isFinite(node)) {
      return;
    }
    if (typeof node !== "object" || !node) {
      throw new Error("TypeSafe input must be JSON.");
    }
    if (
      !Array.isArray(node) &&
      Object.getPrototypeOf(node) !== Object.prototype &&
      Object.getPrototypeOf(node) !== null
    ) {
      throw new Error("TypeSafe input must be plain JSON.");
    }
    for (const [key, item] of Object.entries(node)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error("TypeSafe input contains a reserved key.");
      }
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_BYTES) {
    throw new Error("TypeSafe JSON exceeds the plugin resource limit of 4 MiB.");
  }
}

/** Validate without including supplied state in diagnostics. */
export function parseInput(value: unknown): EvaluationInput {
  assertBoundedJson(value);
  if (!inputValidator.Check(value)) {
    // Report fixed schema guidance and ordinal positions, never supplied values/keys.
    if (
      value &&
      typeof value === "object" &&
      "questions" in value &&
      value.questions &&
      typeof value.questions === "object" &&
      !Array.isArray(value.questions)
    ) {
      for (const [index, q] of Object.values(value.questions).entries()) {
        if (!Check(question, q)) {
          const kind = q && typeof q === "object" && "type" in q ? q.type : undefined;
          const hint =
            kind === "choice"
              ? "Choice requires 2–255 criteria descriptions."
              : kind === "score"
                ? "Score requires 2–10 ordered criteria descriptions."
                : kind === "noul"
                  ? "Noul criteria may contain only true/false descriptions, or null."
                  : "type must be choice, score, or noul.";
          throw new Error(
            `Invalid TypeSafe questions entry #${index + 1}: ${hint} Instructions/descriptions accept text, object, array, or null; no extra question fields.`,
          );
        }
      }
    }
    throw new Error(
      "Invalid TypeSafe evaluation input: supply state (text/object/array/null), a nonempty questions map, and optionally a valid model ID; no extra fields.",
    );
  }
  return value;
}

/** Check the response schema and correspondence to this exact question batch. */
export function parseResult(value: unknown, input: EvaluationInput): Evaluation {
  try {
    assertBoundedJson(value);
    if (!resultValidator.Check(value)) {
      throw new Error();
    }
    const questions = Object.entries(input.questions);
    if (Object.keys(value.answers).length !== questions.length) {
      throw new Error();
    }
    for (const [id, expected] of questions) {
      const answer = value.answers[id];
      if (!answer || answer.type !== expected.type) {
        throw new Error();
      }
      if (answer.type === "noul") {
        continue;
      }
      const labels =
        expected.type === "score"
          ? expected.criteria.map((_, index) => String(index))
          : expected.type === "choice"
            ? Object.keys(expected.criteria)
            : [];
      if (
        Object.keys(answer.probabilities).length !== labels.length ||
        labels.some((label) => !Object.hasOwn(answer.probabilities, label))
      ) {
        throw new Error();
      }
      const total = Object.values(answer.probabilities).reduce((sum, item) => sum + item, 0);
      if (!(total > 0)) {
        throw new Error();
      }
      if (answer.type === "choice" && !labels.includes(answer.choice)) {
        throw new Error();
      }
      if (answer.type === "score" && expected.type === "score") {
        // Score and probabilities are reported independently; do not recompute rounded estimates.
        if (
          answer.score > labels.length - 1 ||
          Object.keys(answer.legend).length !== labels.length ||
          labels.some(
            (label, index) => !isDeepStrictEqual(answer.legend[label], expected.criteria[index]),
          )
        ) {
          throw new Error();
        }
      }
    }
    return value;
  } catch {
    throw new Error("TypeSafe returned an invalid evaluation response.");
  }
}
