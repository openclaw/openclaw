import {
  buildResponsesSearchPayload,
  buildResponsesSearchRequest,
  requireResponsesSearchTextAndCitations,
} from "openclaw/plugin-sdk/provider-web-search";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawRouterCapabilityOffer } from "./capability-offers.js";

export function isClawRouterXaiSearchOffer(offer: ClawRouterCapabilityOffer): boolean {
  const model = offer.model;
  const native = asOptionalRecord(model?.nativeCapabilities);
  const responses = asOptionalRecord(asOptionalRecord(native?.endpoints)?.responses);
  const admission = offer.hostedToolAdmission;
  return (
    offer.providerId === "xai" &&
    offer.endpoint === "responses" &&
    offer.requestFormat === "openai.responses" &&
    offer.responseFormat === "openai.responses" &&
    offer.methods.includes("POST") &&
    (offer.routeKind === "native" || offer.routeKind === "manifest") &&
    model?.upstream === "grok-4.7" &&
    Array.isArray(model.capabilities) &&
    model.capabilities.includes("llm.responses") &&
    Array.isArray(model.supportedReasoningEfforts) &&
    model.supportedReasoningEfforts.includes("low") &&
    native?.version === "clawrouter.native-capabilities.v1" &&
    Array.isArray(responses?.hostedTools) &&
    responses.hostedTools.every((tool) => typeof tool === "string") &&
    responses.hostedTools.includes("web_search") &&
    admission?.version === "clawrouter.hosted-tool-admission.v1" &&
    admission.web_search === "admitted"
  );
}

export function prepareClawRouterXaiSearch(offer: ClawRouterCapabilityOffer, query: string) {
  return {
    url: offer.url,
    body: buildResponsesSearchRequest({
      model: "grok-4.7",
      inputText: query,
      tools: [{ type: "web_search" }],
      reasoningEffort: "low",
    }),
  };
}

export function readClawRouterXaiSearch(payload: unknown, query: string, tookMs: number) {
  const data = asOptionalRecord(payload);
  // Partial work may be billable, but cannot be presented as a completed answer.
  if (data?.status === "failed" || data?.status === "incomplete") {
    throw new Error(`ClawRouter xAI web search returned ${data.status}`);
  }
  if (
    data?.status !== "completed" ||
    data.model !== "grok-4.7" ||
    data.error != null ||
    data.incomplete_details != null ||
    !Array.isArray(data.output)
  ) {
    throw new Error("ClawRouter xAI web search returned a malformed or nonterminal response");
  }
  // Native offsets have no qualified mapping after sanitization/truncation. Usage
  // and post/profile counts remain Worker settlement observations, never citations.
  const answer = requireResponsesSearchTextAndCitations(data, "ClawRouter xAI web search", 20_000);
  return buildResponsesSearchPayload({
    query,
    provider: "clawrouter",
    model: "grok-4.7",
    tookMs,
    ...answer,
  });
}
