import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateOpenAICompatibleDecision } from "openclaw/plugin-sdk/decisions-openai-runtime";

export async function evaluateNaceDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "nace" ||
    context.model.id !== "drex-max-v1.1" ||
    context.model.api !== undefined ||
    (batch.state.type !== "text" && batch.state.type !== "json") ||
    Object.values(batch.questions).some(
      (question) => question.type === "score" && question.criteria.length > 255,
    )
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return evaluateOpenAICompatibleDecision(batch, context, {
    provider: "nace",
    baseUrl: context.model.baseUrl ?? "https://console.nace.ai/v1",
  });
}
