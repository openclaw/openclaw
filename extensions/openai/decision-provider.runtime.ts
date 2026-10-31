import { getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  DecisionBatchV2,
  DecisionProviderV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { executeOpenAIDecision } from "openclaw/plugin-sdk/decisions-openai-runtime";
import { classifyOpenAIBaseUrl, OPENAI_API_BASE_URL } from "./base-url.js";

export async function evaluateOpenAIDecision(
  batch: DecisionBatchV2,
  context: Parameters<DecisionProviderV2["evaluate"]>[1],
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  const endpointKind = classifyOpenAIBaseUrl(context.model.baseUrl);
  if (
    context.model.api !== "openai-responses" ||
    (endpointKind !== "platform" && endpointKind !== "custom")
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return executeOpenAIDecision(batch, {
    provider: "openai",
    modelId: context.model.id,
    baseUrl: endpointKind === "platform" ? OPENAI_API_BASE_URL : context.model.baseUrl!,
    headers: context.model.headers,
    auth: context.auth,
    request: getModelProviderRequestTransport(context.model),
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    reasoning: context.reasoning,
  });
}
