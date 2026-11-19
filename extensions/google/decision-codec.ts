import {
  decodeSystemOneResponse,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionEntry,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Documented Decisions API question-key grammar; answers return under the same keys.
const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/;

type GeminiDecisionBatch = DecisionBatchV2 & {
  state: Exclude<DecisionBatchV2["state"], { type: "list" }>;
};

function text(value: DecisionEntry | undefined): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

/**
 * Gemini requires non-empty instructions, but OpenClaw makes them optional when the
 * criteria already define the judgment. A neutral prompt asks the rubric itself.
 */
function instructionsFor(question: GeminiDecisionBatch["questions"][string]): string {
  const explicit = text(question.instructions);
  if (explicit) {
    return explicit;
  }
  if (question.type === "choice") {
    return "Which option best fits the input?";
  }
  if (question.type === "score") {
    return "Which level best describes the input?";
  }
  return question.type === "boolean" &&
    (question.criteria?.true != null || question.criteria?.false != null)
    ? "Does the true description apply to the input?"
    : "";
}

/** Admit only batches the native wire can represent; malformed caller data still throws. */
export function supportsGeminiDecisionBatch(batch: DecisionBatchV2): batch is GeminiDecisionBatch {
  if (!validateDecisionBatchV2(batch) || batch.state.type === "list") {
    return false;
  }
  if (batch.state.type === "text" && !batch.state.text) {
    return false;
  }
  return Object.entries(batch.questions).every(
    ([id, question]) =>
      QUESTION_KEY.test(id) &&
      // A Boolean needs a question or criteria; the model never sees question keys.
      instructionsFor(question) !== "" &&
      (question.type === "boolean" ||
        question.type === "choice" ||
        (question.type === "score" && question.criteria.every((level) => text(level) !== ""))),
  );
}

function encodeInput(state: GeminiDecisionBatch["state"]) {
  if (state.type === "text") {
    return state.text;
  }
  if (state.type === "json") {
    // Serialized JSON keeps payload keys as data rather than content blocks.
    return JSON.stringify(state.value);
  }
  const [prefix = "", data = ""] = state.dataUri.split(",", 2);
  const image = { type: "image", data, mime_type: prefix.slice(5).split(";", 1)[0] };
  return state.text ? [{ type: "text", text: state.text }, image] : [image];
}

function encodeQuestions(batch: GeminiDecisionBatch) {
  return Object.fromEntries(
    Object.entries(batch.questions).map(([id, question]) => {
      const instructions = instructionsFor(question);
      if (question.type === "boolean") {
        const criteria = question.criteria;
        return [
          id,
          {
            type: "noul",
            instructions,
            ...(criteria && (criteria.true != null || criteria.false != null)
              ? {
                  criteria: {
                    ...(criteria.true != null ? { true_description: text(criteria.true) } : {}),
                    ...(criteria.false != null ? { false_description: text(criteria.false) } : {}),
                  },
                }
              : {}),
          },
        ];
      }
      if (question.type === "choice") {
        return [
          id,
          {
            type: "choice",
            instructions,
            criteria: Object.fromEntries(
              Object.entries(question.criteria).map(([key, value]) => [
                key,
                value == null ? null : text(value),
              ]),
            ),
          },
        ];
      }
      if (question.type !== "score") {
        throw new Error("Unsupported Gemini decision question");
      }
      return [id, { type: "score", instructions, criteria: question.criteria.map(text) }];
    }),
  );
}

export function encodeGeminiDecisionRequest(batch: GeminiDecisionBatch, modelId: string): string {
  return JSON.stringify({
    model: modelId,
    input: encodeInput(batch.state),
    questions: encodeQuestions(batch),
  });
}

export function decodeGeminiDecisionResult(
  batch: GeminiDecisionBatch,
  payload: unknown,
  modelId: string,
  capabilities: Parameters<typeof validateDecisionResultV2>[2],
): ProviderDecisionOutcomeV2 {
  const invalid = { status: "unavailable", reason: "invalid-response" } as const;
  const { answers, usage } = isRecord(payload) ? payload : {};
  // Gemini Decision generates no text tokens; nonzero output means a different contract.
  if (!isRecord(answers) || !isRecord(usage) || usage.total_output_tokens !== 0) {
    return invalid;
  }
  for (const [id, question] of Object.entries(batch.questions)) {
    if (question.type !== "score") {
      continue;
    }
    // The legend echoes rubric levels by index; a mismatch would misread the score scale.
    const legend = isRecord(answers[id]) ? answers[id].legend : undefined;
    if (
      !isRecord(legend) ||
      Object.keys(legend).length !== question.criteria.length ||
      question.criteria.some((level, index) => legend[String(index)] !== text(level))
    ) {
      return invalid;
    }
  }
  // The documented response names no model, so provenance records the requested ID.
  const result = decodeSystemOneResponse(batch, {
    model: modelId,
    answers,
    usage: { input_tokens: usage.total_input_tokens, output_tokens: usage.total_output_tokens },
  });
  return validateDecisionResultV2(batch, result, capabilities) ? { status: "ok", result } : invalid;
}
