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

const MODELS = new Set([
  "decision-models/baseten-elephant-9b-latest",
  "decision-models/baseten-mammoth-27b-latest",
  "decision-models/baseten-joey-2b-latest",
]);

export function readBasetenDecisionOffer(offer: ClawRouterCapabilityOffer) {
  const model = offer.model;
  const upstream = normalizeOptionalString(model?.upstream);
  if (
    offer.providerId !== "baseten" ||
    !upstream ||
    !MODELS.has(upstream) ||
    model?.id !== `baseten/${upstream}` ||
    !Array.isArray(model.capabilities) ||
    model.capabilities.length !== 1 ||
    model.capabilities[0] !== "llm.decisions" ||
    offer.path !== "/systemone" ||
    offer.endpoint !== "systemone" ||
    offer.requestFormat !== "baseten.systemone" ||
    offer.responseFormat !== "baseten.systemone" ||
    !offer.methods.includes("POST") ||
    offer.routeKind === "unified"
  ) {
    return undefined;
  }
  const native = asOptionalRecord(model.nativeCapabilities);
  const endpoint = asOptionalRecord(asOptionalRecord(native?.endpoints)?.[offer.endpoint]);
  const declared = asOptionalRecord(endpoint?.inference);
  const decision = asOptionalRecord(declared?.decision);
  const limits = asOptionalRecord(decision?.limits);
  if (
    native?.version !== "clawrouter.native-capabilities.v1" ||
    declared?.chat !== false ||
    decision?.protocol !== "baseten-systemone" ||
    decision.outputTokensPerQuestion !== 1 ||
    limits?.maxTotalOptions !== 512 ||
    limits.maxStateAndQuestionTokens !== 16384 ||
    !Array.isArray(endpoint?.input) ||
    !endpoint.input.includes("text") ||
    endpoint.input.some((input) => input !== "text" && input !== "json")
  ) {
    return undefined;
  }
  const parsed = ModelInferenceCapabilitiesSchema.safeParse({
    chat: false,
    decision: { ...decision, input: ["text"] },
  });
  if (!parsed.success || !parsed.data.decision) {
    return undefined;
  }
  const facts = parsed.data.decision;
  const questions = facts.questions;
  if (
    !questions ||
    Object.keys(questions).length !== 3 ||
    questions.boolean?.probabilities !== "boolean" ||
    questions.boolean.abstention !== false ||
    questions.choice?.probabilities !== "provider-defined" ||
    questions.choice.abstention !== false ||
    questions.choice.minOptions !== 2 ||
    questions.choice.maxOptions !== 255 ||
    questions.score?.probabilities !== "provider-defined" ||
    questions.score.abstention !== false ||
    questions.score.minOptions !== 2 ||
    questions.score.maxOptions !== 10 ||
    facts.reasoning?.modes.length !== 1 ||
    facts.reasoning.modes[0] !== "auto" ||
    facts.confidence !== "provider-specific"
  ) {
    return undefined;
  }
  return { offer, upstream, inference: parsed.data };
}

export async function listClawRouterBasetenDecisionModels(
  context: ProviderAugmentModelCatalogContext,
): Promise<ProviderAugmentModelCatalogContext["entries"]> {
  const auth = context.resolveProviderApiKey?.("clawrouter");
  const apiKey = auth?.discoveryApiKey ?? auth?.apiKey;
  if (!context.config || !apiKey) {
    return [];
  }
  const http = resolveClawRouterCapabilityHttpContext(context.config, apiKey);
  http.headers.delete("x-api-key");
  let offers: ClawRouterCapabilityOffer[];
  try {
    offers = await fetchClawRouterCapabilityOffers({
      context: http,
      timeoutMs: () => 5_000,
      requireFreshProxyCatalog: true,
    });
  } catch {
    // Failed native discovery must not suppress unrelated, already known rows.
    return [];
  }
  const entries = new Map<string, ProviderAugmentModelCatalogContext["entries"][number]>();
  for (const offer of offers) {
    const qualified = readBasetenDecisionOffer(offer);
    if (!qualified) {
      continue;
    }
    const id = `baseten/${qualified.upstream}`;
    entries.set(id, {
      provider: "clawrouter",
      id,
      name: normalizeOptionalString(offer.model?.displayName) ?? `Baseten · ${qualified.upstream}`,
      baseUrl: http.baseUrl,
      inference: qualified.inference,
    });
  }
  return [...entries.values()];
}
