import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { isOpenAISubscriptionOnlyRouteModelId } from "./model-route-contract.js";

// Zero rates are unknown pricing to usage reporting, not a free model.
export const OPENAI_UNKNOWN_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} satisfies ModelDefinitionConfig["cost"];

// API-key turns use /v1/responses, which rejects search models with 400 "not supported
// with the Responses API" (#167462; dated snapshots too, 2026-11-16).
const OPENAI_RESPONSES_UNSUPPORTED_MODEL_ID_PATTERN = /(?:^|-)search(?:-|$)/;
// Listed live, cyber, experiment and alpha ids often return 404 or 500 for the listing
// key (#167462, re-probed 2026-11-16), but some accounts are entitled to them. They stay
// out of default pickers; a typed or configured ref still runs.
const OPENAI_UNLIKELY_ACCOUNT_MODEL_ID_PATTERN = /(?:^|-)(?:live|cyber|exp|alpha)(?:-|$)/;
// Listings advertise the modern tool surface; many pre-GPT-5 models reject hosted
// web search. Explicitly selected refs still resolve with function tools.
export const OPENAI_PRE_GPT5_MODEL_ID_PATTERN = /^(?:ft:)?(?:gpt-3\.5|gpt-4|o[134])/;

/** Conservative Responses metadata for an OpenAI chat id without a catalog row. */
export function buildOpenAIUncataloguedModel(id: string, baseUrl: string) {
  return {
    id,
    name: id,
    api: "openai-responses",
    baseUrl,
    // GPT-5+ and o-series reason; older GPT families reject reasoning parameters.
    reasoning: /^(?:gpt-(?:[5-9]|\d{2})|o\d)/.test(id),
    input: ["text"],
    cost: OPENAI_UNKNOWN_MODEL_COST,
    contextWindow: 128_000,
    maxTokens: 16_384,
  } satisfies ModelDefinitionConfig;
}

/**
 * Keeps catalog rows for listed ids and gives every other runnable listed chat id
 * conservative Responses metadata. Shared prefix templates are not used here: every
 * OpenAI id shares "gpt-", and GPT-5 reasoning settings make GPT-4-family requests fail.
 */
export function projectOpenAIAccountModels(params: {
  listedModels: readonly ModelDefinitionConfig[];
  catalogModels: readonly ModelDefinitionConfig[];
  baseUrl: string;
}): ModelDefinitionConfig[] {
  const catalogIds = new Set(params.catalogModels.map((model) => model.id));
  return params.listedModels.flatMap((model): ModelDefinitionConfig[] => {
    if (model.inference?.chat === false) {
      return [model];
    }
    if (OPENAI_PRE_GPT5_MODEL_ID_PATTERN.test(model.id)) {
      return [];
    }
    if (catalogIds.has(model.id)) {
      return [model];
    }
    if (
      OPENAI_RESPONSES_UNSUPPORTED_MODEL_ID_PATTERN.test(model.id) ||
      isOpenAISubscriptionOnlyRouteModelId(model.id)
    ) {
      return [];
    }
    const uncatalogued = buildOpenAIUncataloguedModel(model.id, params.baseUrl);
    return [
      model.inference?.chatEvidence === "unlikely" ||
      OPENAI_UNLIKELY_ACCOUNT_MODEL_ID_PATTERN.test(model.id)
        ? { ...uncatalogued, inference: { chat: true, chatEvidence: "unlikely" } }
        : uncatalogued,
    ];
  });
}
