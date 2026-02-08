import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";
  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  const isBailian = model.provider === "bailian" || baseUrl.includes("dashscope.aliyuncs.com");

  if ((!isZai && !isBailian) || !isOpenAiCompletionsModel(model)) {
    return model;
  }

  const openaiModel = model;
  const compat = openaiModel.compat ?? undefined;

  if (isZai) {
    // Z.ai only needs supportsDeveloperRole: false
    openaiModel.compat = compat
      ? { ...compat, supportsDeveloperRole: false }
      : { supportsDeveloperRole: false };
  } else if (isBailian) {
    // Bailian/DashScope needs both supportsDeveloperRole: false and thinkingFormat: "qwen"
    openaiModel.compat = compat
      ? { ...compat, supportsDeveloperRole: false, thinkingFormat: "qwen" }
      : { supportsDeveloperRole: false, thinkingFormat: "qwen" };
  }
  return openaiModel;
}
