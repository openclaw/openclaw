import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { evaluateDecisionHttp } from "openclaw/plugin-sdk/decisions-http-runtime";
import {
  decodeSageDecisionResult,
  encodeSageDecisionInput,
  encodeSageDecisionRequest,
} from "./decision-codec.js";
import {
  parseSageBatchResponse,
  parseSageResponse,
  validateSageImage,
  type SageImageProbe,
} from "./sage-validation.js";

export async function evaluateLevantoDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
  probeImage: SageImageProbe,
): Promise<ProviderDecisionOutcomeV2> {
  let encoded: ReturnType<typeof encodeSageDecisionInput>;
  try {
    encoded = encodeSageDecisionInput(batch);
  } catch {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const request =
    encoded &&
    encodeSageDecisionRequest(encoded.nativeContent, encoded.questions, context.reasoning);
  if (!encoded || !request) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const { nativeContent, questions } = encoded;
  if (typeof nativeContent !== "string" && nativeContent.kind === "image") {
    try {
      await validateSageImage(nativeContent.media, probeImage);
    } catch {
      return { status: "unavailable", reason: "unsupported-input" };
    }
  }
  return evaluateDecisionHttp(context, {
    provider: "levanto",
    baseUrl: context.model.baseUrl ?? "https://sage.levanto.ai",
    endpointPath: "requests" in request ? "decide/batch" : "decide",
    body: JSON.stringify(request),
    decode: (payload) =>
      decodeSageDecisionResult(
        batch,
        questions,
        "requests" in request
          ? parseSageBatchResponse(payload, request)
          : parseSageResponse(payload, request.question, request.content),
        context.model.id,
        context.model.inference?.decision,
      ),
  });
}
