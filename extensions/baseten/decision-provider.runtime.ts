import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";
import { decodeBasetenDecisionResult, encodeBasetenDecisionRequest } from "./decision-codec.js";
import { BASETEN_BASE_URL, BASETEN_DECISION_MODEL_IDS } from "./models.js";

export async function evaluateBasetenDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
): Promise<ProviderDecisionOutcomeV2> {
  context.signal.throwIfAborted();
  if (
    context.model.provider !== "baseten" ||
    !BASETEN_DECISION_MODEL_IDS.has(context.model.id) ||
    !["text", "json"].includes(batch.state.type) ||
    Object.values(batch.questions).some((q) => !["boolean", "choice", "score"].includes(q.type)) ||
    (context.reasoning !== undefined && context.reasoning !== "auto")
  ) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return evaluateDecisionHttp(context, {
    provider: "baseten",
    baseUrl: context.model.baseUrl ?? BASETEN_BASE_URL,
    endpointPath: "systemone",
    body: encodeBasetenDecisionRequest(batch, context.model.id),
    decode: (payload) => decodeBasetenDecisionResult(batch, payload),
  });
}
