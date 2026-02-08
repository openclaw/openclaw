import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";
  const providerKey = model.provider?.trim().toLowerCase() ?? "";

  const isOpenAiCompletions = isOpenAiCompletionsModel(model);

  // Qwen OpenAI-compatible endpoints (DashScope / Qwen Portal) use
  // `enable_thinking` instead of `reasoning_effort`.
  //
  // pi-ai exposes this via `compat.thinkingFormat = "qwen"`.
  const isQwenCompat =
    isOpenAiCompletions &&
    (providerKey === "qwen-portal" ||
      providerKey === "dashscope" ||
      baseUrl.includes("portal.qwen.ai") ||
      baseUrl.includes("dashscope.aliyuncs.com"));
  if (isQwenCompat) {
    const openaiModel = model;
    const compat = openaiModel.compat ?? undefined;

    // Respect explicit thinkingFormat overrides.
    if (!compat?.thinkingFormat) {
      openaiModel.compat = compat
        ? { ...compat, thinkingFormat: "qwen" }
        : { thinkingFormat: "qwen" };
    }
    return openaiModel;
  }

  // z.ai OpenAI-compatible API does not support the OpenAI `developer` role.
  const isZai = providerKey === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai || !isOpenAiCompletions) {
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
