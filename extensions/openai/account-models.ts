import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { isOpenAISubscriptionOnlyRouteModelId } from "./model-route-contract.js";

// Zero rates are unknown pricing to usage reporting, not a free model.
export const OPENAI_UNKNOWN_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} satisfies ModelDefinitionConfig["cost"];

// API-key turns use /v1/responses. These account-listed chat ids cannot run there:
// search models are Chat Completions only, and live, cyber, experiment and alpha
// codename ids return 404/500 for API keys that list them.
const OPENAI_RESPONSES_UNSUPPORTED_MODEL_ID_PATTERN =
  /(?:^|-)(?:search|live|cyber|exp|alpha)(?:-|$)/;
// Pre-GPT-5 families fail on the default Codex runtime (400 "Invalid value: 'custom'") and
// many reject hosted web search; explicit config with the OpenClaw runtime still runs them.
const OPENAI_PRE_GPT5_MODEL_ID_PATTERN = /^(?:ft:)?(?:gpt-3\.5|gpt-4|o[134])/;

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
    return [
      {
        id: model.id,
        name: model.id,
        api: "openai-responses",
        baseUrl: params.baseUrl,
        // GPT-5+ and o-series reason; older GPT families reject reasoning parameters.
        reasoning: /^(?:gpt-(?:[5-9]|\d{2})|o\d)/.test(model.id),
        input: ["text"],
        cost: OPENAI_UNKNOWN_MODEL_COST,
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ];
  });
}
