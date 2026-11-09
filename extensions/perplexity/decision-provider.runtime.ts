import {
  decodeSystemOneResponse,
  encodeSystemOneQuestions,
  isDecisionBatchV1Representable,
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
  type ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";

export async function evaluatePerplexityDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "perplexity-decisions" ||
    context.model.id !== "pplx-decider-v1.2" ||
    context.model.api !== undefined ||
    !isDecisionBatchV1Representable(batch) ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    Object.keys(batch.questions).length > 128 ||
    Object.values(batch.questions).some(
      (q) =>
        (q.type === "choice" && Object.keys(q.criteria).length > 255) ||
        (q.type === "score" && q.criteria.length > 10),
    )
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return evaluateDecisionHttp(context, {
    provider: "perplexity-decisions",
    baseUrl: context.model.baseUrl ?? "https://api.perplexity.ai/v1",
    endpointPath: "decisions",
    body: JSON.stringify({
      model: context.model.id,
      // Serialize JSON as evidence; do not interpret nested objects as native image parts.
      state: batch.state.type === "text" ? batch.state.text : JSON.stringify(batch.state.value),
      questions: encodeSystemOneQuestions(batch),
    }),
    decode: (payload) => {
      const result = decodeSystemOneResponse(batch, payload);
      return validateDecisionResultV2(batch, result)
        ? { status: "ok", result }
        : { status: "unavailable", reason: "invalid-response" };
    },
  });
}
