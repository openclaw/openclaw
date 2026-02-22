import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  const baseUrl = model.baseUrl ?? "";
  const provider = model.provider ?? "";
  const needsDeveloperRoleOff =
    provider === "zai" ||
    baseUrl.includes("api.z.ai") ||
    provider === "dashscope" ||
    baseUrl.includes("dashscope.aliyuncs.com") ||
    provider === "qwen-portal" ||
    baseUrl.includes("portal.qwen.ai");

  if (!needsDeveloperRoleOff) {
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
