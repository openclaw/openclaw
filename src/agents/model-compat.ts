import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function hasHostname(baseUrl: string, hostname: string): boolean {
  try {
    return new URL(baseUrl).hostname === hostname;
  } catch {
    return false;
  }
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";
  const isZai = model.provider === "zai" || hasHostname(baseUrl, "api.z.ai");
  const isMoonshot = model.provider === "moonshot" || hasHostname(baseUrl, "api.moonshot.ai");
  if ((!isZai && !isMoonshot) || !isOpenAiCompletionsModel(model)) {
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
