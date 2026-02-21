import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function isMoonshotProvider(model: Model<Api>): boolean {
  const baseUrl = model.baseUrl ?? "";
  return model.provider === "moonshot" || baseUrl.includes("api.moonshot.ai");
}

function isZaiProvider(model: Model<Api>): boolean {
  const baseUrl = model.baseUrl ?? "";
  return model.provider === "zai" || baseUrl.includes("api.z.ai");
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const isZai = isZaiProvider(model);
  const isMoonshot = isMoonshotProvider(model);
  if (!isZai && !isMoonshot) {
    return model;
  }

  if (!isOpenAiCompletionsModel(model)) {
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
