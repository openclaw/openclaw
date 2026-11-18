import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";
import { decodeParallelDecisionResult, encodeParallelDecisionRequest } from "./decision-codec.js";

export async function evaluateParallelDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  const providerConfig = context.config.models?.providers?.parallel;
  const agent = context.agentId ? resolveAgentConfig(context.config, context.agentId) : undefined;
  const modelRef = "parallel/" + context.model.id;
  const hasParams = [
    providerConfig?.params,
    context.model.params,
    context.config.agents?.defaults?.params,
    context.config.agents?.defaults?.models?.[modelRef]?.params,
    agent?.models?.[modelRef]?.params,
    agent?.params,
  ].some((params) => Object.values(params ?? {}).some((value) => value !== undefined));
  const body = encodeParallelDecisionRequest(batch);
  // The native endpoint has no generation controls. Preserve authored limits/privacy
  // settings by refusing unsupported controls rather than silently dropping them.
  if (
    context.model.id !== "decisions-fast" ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    hasParams ||
    !body
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return evaluateDecisionHttp(context, {
    provider: "parallel",
    baseUrl: context.model.baseUrl ?? providerConfig?.baseUrl ?? "https://api.parallel.ai/v1",
    endpointPath: "decisions",
    body,
    authHeaders: (apiKey) => ({ "x-api-key": apiKey }),
    decode: (payload) =>
      decodeParallelDecisionResult(batch, payload, context.model.inference?.decision),
  });
}
