import type { Api, Model } from "@mariozechner/pi-ai";
import { resolveProviderCapabilities } from "./provider-capabilities.js";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  const caps = resolveProviderCapabilities({
    provider: model.provider,
    modelApi: model.api,
    baseUrl: model.baseUrl,
  });
  if (caps.supportsDeveloperRole) {
    return model;
  }

  const openaiModel = model;
  const compat = openaiModel.compat ?? undefined;
  if (compat?.supportsDeveloperRole === false) {
    return model;
  }

  openaiModel.compat = compat
    ? { ...compat, supportsDeveloperRole: false }
    : { supportsDeveloperRole: false };
  return openaiModel;
}
