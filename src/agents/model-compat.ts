import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function isZaiGlm5Model(model: Model<Api>): boolean {
  const normalizedId = model.id?.trim().toLowerCase();
  if (!normalizedId) {
    return false;
  }
  return normalizedId === "glm-5" || normalizedId.startsWith("glm-5-");
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";
  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai || !isOpenAiCompletionsModel(model)) {
    return model;
  }

  const openaiModel = model;
  const compat = openaiModel.compat ?? undefined;
  if (compat?.supportsDeveloperRole !== false) {
    openaiModel.compat = compat
      ? { ...compat, supportsDeveloperRole: false }
      : { supportsDeveloperRole: false };
  }

  // Some pi-ai catalogs still mark GLM-5 as text-only. OpenClaw can use image
  // inputs on GLM-5 endpoints, so advertise vision to unlock attachment flows.
  if (isZaiGlm5Model(openaiModel) && !openaiModel.input.includes("image")) {
    openaiModel.input = [...openaiModel.input, "image"];
  }

  return openaiModel;
}
