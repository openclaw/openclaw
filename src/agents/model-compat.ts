import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAICompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const isOpenAICompletionsModel = (
    candidate: Model<Api>,
  ): candidate is Model<"openai-completions"> => candidate.api === "openai-completions";
  const baseUrl = model.baseUrl ?? "";
  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai || !isOpenAICompletionsModel(model)) return model;

  const compat = model.compat ?? {};
  if (compat.supportsDeveloperRole === false) return model;

  model.compat = { ...compat, supportsDeveloperRole: false };
  return model;
}
