import {
  decodeSystemOneResponse,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
  type DecisionEntry,
} from "openclaw/plugin-sdk/decisions";
import { evaluateDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function text(value: DecisionEntry | undefined): string {
  return value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
}

export async function evaluateFastinoDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "fastino" ||
    context.model.id !== "fastino/GLiDE" ||
    context.model.api !== undefined ||
    !validateDecisionBatchV2(batch) ||
    (batch.state.type !== "text" && batch.state.type !== "json") ||
    Object.keys(batch.questions).length > 256 ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    Object.values(batch.questions).some(
      (q) =>
        (q.type === "choice" && Object.keys(q.criteria).length > 255) ||
        (q.type === "score" && q.criteria.length > 255),
    )
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const questions: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(batch.questions)) {
    if (q.type !== "boolean" && q.type !== "choice" && q.type !== "score") {
      return { status: "unavailable", reason: "unsupported-input" };
    }
    questions[id] = {
      type: q.type === "boolean" ? "noul" : q.type,
      instructions:
        text(q.instructions) ||
        (q.type === "boolean"
          ? "Evaluate the true and false criteria."
          : q.type === "choice"
            ? "Choose the option that best matches the state."
            : "Rate the state against the ordered rubric."),
      ...(q.type === "score"
        ? { criteria: q.criteria.map(text) }
        : q.criteria
          ? {
              criteria: Object.fromEntries(
                Object.entries(q.criteria).map(([key, value]) => [key, text(value)]),
              ),
            }
          : {}),
    };
  }
  return evaluateDecisionHttp(context, {
    provider: "fastino",
    baseUrl: context.model.baseUrl ?? "https://api.fastino.ai/v1",
    endpointPath: "systemone",
    body: JSON.stringify({
      model: context.model.id,
      // A JSON string remains evidence, not native media instructions or remote image URLs.
      state: batch.state.type === "text" ? batch.state.text : JSON.stringify(batch.state.value),
      questions,
      store: false,
    }),
    decode: (payload) => {
      const invalid = { status: "unavailable", reason: "invalid-response" } as const;
      if (!isRecord(payload) || !isRecord(payload.answers)) {
        return invalid;
      }
      const answers = Object.fromEntries(
        Object.entries(payload.answers).map(([id, answer]) => [
          id,
          isRecord(answer) && answer.type === "score"
            ? { ...answer, score: answer.expected_level }
            : answer,
        ]),
      );
      // GLiDE's score is argmax; expected_level is the fractional rubric position.
      // Never derive it from rounded probabilities or silently substitute the integer.
      const result = decodeSystemOneResponse(batch, { ...payload, answers });
      return validateDecisionResultV2(batch, result) ? { status: "ok", result } : invalid;
    },
  });
}
