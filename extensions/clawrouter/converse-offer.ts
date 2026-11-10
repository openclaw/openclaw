import type { ClawRouterCapabilityOffer } from "./capability-offers.js";

// Frozen Nova V1 Lite is explicitly qualified for both Converse operations:
// https://docs.aws.amazon.com/nova/latest/userguide/using-converse-api.html
// This does not confer capability on Claude, regional aliases or inference profiles.
export const CONVERSE_MODEL = "amazon.nova-lite-v1:0";
const PATH = "/model/${model}/converse-stream";

export function selectConverseOffer(
  offers: readonly ClawRouterCapabilityOffer[],
  id: string,
  upstream: string,
): ClawRouterCapabilityOffer | undefined {
  if (upstream !== CONVERSE_MODEL || id !== "aws-bedrock/" + upstream) {
    return undefined;
  }
  const eligible = offers.filter(
    (offer) =>
      offer.providerId === "aws-bedrock" &&
      offer.model?.id === id &&
      offer.model.upstream === upstream &&
      Array.isArray(offer.model.capabilities) &&
      offer.model.capabilities.includes("llm.chat") &&
      offer.methods.length === 1 &&
      offer.methods[0] === "POST" &&
      offer.path === PATH &&
      offer.requestFormat === "aws_bedrock.converse_stream" &&
      offer.responseFormat === "aws_bedrock.converse_eventstream" &&
      (offer.routeKind === "native" || offer.routeKind === "manifest"),
  );
  // Prefer the exact native operation, never ordering among distinct endpoints.
  const native = eligible.filter((offer) => offer.routeKind === "native");
  const selected = native.length ? native : eligible;
  return selected.length === 1 ? selected[0] : undefined;
}

export function converseBaseUrl(offer: ClawRouterCapabilityOffer): string {
  return offer.routeKind === "native"
    ? offer.url.slice(
        0,
        -("/model/" + encodeURIComponent(CONVERSE_MODEL) + "/converse-stream").length,
      )
    : offer.url;
}
