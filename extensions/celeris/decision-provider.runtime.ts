import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateOpenAICompatibleDecision } from "openclaw/plugin-sdk/decisions-openai-runtime";

export async function evaluateCelerisDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "celeris" ||
    context.model.id !== "celeris-1.1-decision" ||
    context.model.api !== undefined ||
    (batch.state.type !== "text" && batch.state.type !== "json") ||
    Object.values(batch.questions).some(
      (question) => question.type === "score" && question.criteria.length > 64,
    )
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return evaluateOpenAICompatibleDecision(batch, context, {
    provider: "celeris",
    baseUrl: context.model.baseUrl ?? "https://inference.celeris.ai/celeris-1-decision/v1",
  });
}
