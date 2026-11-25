import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";
import {
  decodeGeminiDecisionResult,
  encodeGeminiDecisionRequest,
  supportsGeminiDecisionBatch,
} from "./decision-codec.js";
import { parseGeminiAuth } from "./gemini-auth.js";
import { resolveTrustedGoogleGenerativeAiBaseUrl } from "./http-request.js";

export async function evaluateGeminiDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  const capabilities = context.model.inference?.decision;
  if (
    context.model.provider !== "google" ||
    capabilities?.protocol !== "gemini-decisions" ||
    (context.reasoning !== undefined && context.reasoning !== "auto") ||
    !supportsGeminiDecisionBatch(batch)
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  let baseUrl: string;
  try {
    // The Decisions API exists only on the Gemini Developer API host.
    baseUrl = resolveTrustedGoogleGenerativeAiBaseUrl(context.model.baseUrl);
  } catch {
    return { status: "unavailable", reason: "transport" };
  }
  return evaluateDecisionHttp(context, {
    provider: "google",
    baseUrl,
    endpointPath: "decisions",
    body: encodeGeminiDecisionRequest(batch, context.model.id),
    authHeaders: (apiKey) => parseGeminiAuth(apiKey).headers,
    maxResponseBytes: 4_194_304,
    decode: (payload) => decodeGeminiDecisionResult(batch, payload, context.model.id, capabilities),
  });
}
