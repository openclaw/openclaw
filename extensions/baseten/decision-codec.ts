import {
  decodeSystemOneResponse,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionEntry,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function text(value: DecisionEntry | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

function questions(batch: DecisionBatchV2) {
  return Object.fromEntries(
    Object.entries(batch.questions).map(([id, q]) => {
      const instructions = text(q.instructions);
      if (q.type === "boolean") {
        return [
          id,
          {
            type: "noul",
            instructions: q.criteria
              ? `${instructions}\nTrue criterion: ${text(q.criteria.true)}\nFalse criterion: ${text(q.criteria.false)}`
              : instructions,
          },
        ];
      }
      if (q.type === "choice") {
        return [
          id,
          {
            type: "choice",
            instructions,
            criteria: Object.fromEntries(
              Object.entries(q.criteria).map(([key, value]) => [key, text(value)]),
            ),
          },
        ];
      }
      if (q.type === "score") {
        return [id, { type: "score", instructions, criteria: q.criteria.map(text) }];
      }
      throw new Error("Unsupported Baseten decision question");
    }),
  );
}

export function decodeBasetenDecisionResult(
  batch: DecisionBatchV2,
  payload: Record<string, unknown>,
): ProviderDecisionOutcomeV2 {
  const invalid = { status: "unavailable", reason: "invalid-response" } as const;
  if (!isRecord(payload.answers) || !isRecord(payload.usage)) {
    return invalid;
  }
  const usage = payload.usage;
  if (usage.output_tokens !== Object.keys(batch.questions).length) {
    return invalid;
  }
  for (const [id, q] of Object.entries(batch.questions)) {
    if (q.type !== "score") {
      continue;
    }
    const answer = payload.answers[id];
    const legend = isRecord(answer) ? answer.legend : undefined;
    if (
      !isRecord(legend) ||
      Object.keys(legend).length !== q.criteria.length ||
      q.criteria.some((value, index) => legend[String(index)] !== text(value))
    ) {
      return invalid;
    }
  }
  // Baseten exposes the served model and token usage, without other native accounting fields.
  const result = decodeSystemOneResponse(batch, {
    model: payload.model,
    answers: payload.answers,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
  });
  return validateDecisionResultV2(batch, result) ? { status: "ok", result } : invalid;
}

export function encodeBasetenDecisionRequest(batch: DecisionBatchV2, modelId: string): string {
  return JSON.stringify({
    model: modelId,
    state:
      batch.state.type === "text"
        ? batch.state.text
        : batch.state.type === "json"
          ? JSON.stringify(batch.state.value)
          : "",
    questions: questions(batch),
  });
}
