import { ModelInferenceCapabilitiesSchema } from "openclaw/plugin-sdk/decisions";
import type { ProviderAugmentModelCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
  type ClawRouterCapabilityOffer,
} from "./capability-offers.js";

export function readLiquidDecisionOffer(offer: ClawRouterCapabilityOffer) {
  const model = offer.model;
  const upstream = normalizeOptionalString(model?.upstream);
  if (
    offer.providerId !== "liquid-ai" ||
    !upstream ||
    !["d1", "d1-ultra"].includes(upstream) ||
    model?.id !== `liquid-ai/${upstream}` ||
    !Array.isArray(model.capabilities) ||
    !model.capabilities.includes("llm.decisions") ||
    offer.requestFormat !== "liquid.systemone" ||
    offer.responseFormat !== "liquid.systemone" ||
    !offer.methods.includes("POST") ||
    offer.routeKind === "unified"
  ) {
    return undefined;
  }
  const native = asOptionalRecord(model.nativeCapabilities);
  const endpoint = asOptionalRecord(asOptionalRecord(native?.endpoints)?.[offer.endpoint]);
  const declared = asOptionalRecord(endpoint?.inference);
  const decision = asOptionalRecord(declared?.decision);
  if (
    native?.version !== "clawrouter.native-capabilities.v1" ||
    declared?.chat !== false ||
    decision?.protocol !== "liquid-ai-systemone" ||
    !Array.isArray(endpoint?.input)
  ) {
    return undefined;
  }
  // The endpoint supplies input and billing qualifications. Never infer a chat API,
  // token ceiling or price from the native provider's model name.
  const parsed = ModelInferenceCapabilitiesSchema.safeParse({
    chat: false,
    decision: {
      ...decision,
      input: endpoint.input.filter((input) => input === "text" || input === "image"),
    },
  });
  if (
    !parsed.success ||
    !parsed.data.decision ||
    Object.keys(parsed.data.decision.questions ?? {}).some(
      (kind) => !["boolean", "choice", "score"].includes(kind),
    )
  ) {
    return undefined;
  }
  return { offer, upstream, inference: parsed.data };
}

export async function listClawRouterDecisionModels(
  context: ProviderAugmentModelCatalogContext,
): Promise<ProviderAugmentModelCatalogContext["entries"]> {
  const auth = context.resolveProviderApiKey?.("clawrouter");
  const apiKey = auth?.discoveryApiKey ?? auth?.apiKey;
  if (!context.config || !apiKey) {
    return [];
  }
  const http = resolveClawRouterCapabilityHttpContext(context.config, apiKey);
  const offers = await fetchClawRouterCapabilityOffers({
    context: http,
    timeoutMs: () => 5_000,
    allowLegacyCatalog: true,
  });
  return offers.flatMap((offer) => {
    const qualified = readLiquidDecisionOffer(offer);
    if (!qualified) {
      return [];
    }
    return [
      {
        provider: "clawrouter",
        id: `liquid-ai/${qualified.upstream}`,
        name:
          normalizeOptionalString(offer.model?.displayName) ?? `Liquid AI · ${qualified.upstream}`,
        baseUrl: http.baseUrl,
        inference: qualified.inference,
      },
    ];
  });
}
