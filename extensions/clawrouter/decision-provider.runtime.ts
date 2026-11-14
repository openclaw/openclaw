import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";
import {
  evaluateOpenAICompatibleDecision,
  supportsOpenAIDecisionBatch,
} from "openclaw/plugin-sdk/decisions-openai-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterRootUrl } from "./base-url.js";
import { grantsLuna } from "./decision-catalog.js";

export async function evaluateClawRouterDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "clawrouter" ||
    context.model.id !== "openai/gpt-6-luna" ||
    context.model.api !== "openai-responses" ||
    !supportsOpenAIDecisionBatch(batch, context.reasoning)
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const root = normalizeClawRouterRootUrl(context.model.baseUrl);
  // Eligibility is checked with this call's effective key and transport. Do not
  // share grants or in-flight requests across agent authorities or endpoints.
  const grant = await evaluateDecisionHttp(context, {
    provider: "clawrouter",
    baseUrl: root,
    endpointPath: "v1/catalog",
    maxResponseBytes: 4_194_304,
    decode: (payload) =>
      !isRecord(payload) || !Array.isArray(payload.providers)
        ? { status: "unavailable", reason: "invalid-response" }
        : grantsLuna(payload.providers)
          ? { status: "ready" as const }
          : { status: "unavailable", reason: "unsupported-input" },
  });
  if (grant.status !== "ready") {
    return grant;
  }
  return evaluateOpenAICompatibleDecision(batch, context, {
    provider: "clawrouter",
    baseUrl: root + "/v1/native/openai/v1",
    modelId: "gpt-6-luna",
  });
}
