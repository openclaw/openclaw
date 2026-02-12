import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

const PROVIDERS_REQUIRING_PREFIX_STRIP = new Set([
  "anthropic",
  // Add more providers here as needed:
  // "openai",
  // "google",
]);

function stripProviderPrefixFromModelId(model: Model<Api>): Model<Api> {
  const provider = model.provider?.toLowerCase();
  if (!provider) {
    return model;
  }

  if (!PROVIDERS_REQUIRING_PREFIX_STRIP.has(provider)) {
    return model;
  }

  const modelId = model.id;
  const prefix = `${provider}/`;
  if (modelId.toLowerCase().startsWith(prefix)) {
    return { ...model, id: modelId.slice(prefix.length) };
  }

  return model;
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const strippedModel = stripProviderPrefixFromModelId(model);

  const baseUrl = strippedModel.baseUrl ?? "";
  const isZai = strippedModel.provider === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai || !isOpenAiCompletionsModel(strippedModel)) {
    return strippedModel;
  }

  const openaiModel = strippedModel;
  const compat = openaiModel.compat ?? undefined;
  if (compat?.supportsDeveloperRole === false) {
    return strippedModel;
  }

  openaiModel.compat = compat
    ? { ...compat, supportsDeveloperRole: false }
    : { supportsDeveloperRole: false };
  return openaiModel;
}
