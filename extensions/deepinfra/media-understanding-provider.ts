import {
  describeImageWithModel,
  describeImagesWithModel,
  transcribeOpenAiCompatibleAudio,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_STT_FALLBACK_MODELS,
  DEEPINFRA_VLM_FALLBACK_MODELS,
} from "./media-models.js";
export const deepinfraMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "deepinfra",
  capabilities: ["image", "audio"],
  defaultModels: {
    image: DEEPINFRA_VLM_FALLBACK_MODELS[0],
    audio: DEEPINFRA_STT_FALLBACK_MODELS[0],
  },
  autoPriority: {
    image: 45,
    audio: 45,
  },
  transcribeAudio: (params) =>
    transcribeOpenAiCompatibleAudio({
      ...params,
      provider: "deepinfra",
      defaultBaseUrl: DEEPINFRA_BASE_URL,
      defaultModel: DEEPINFRA_STT_FALLBACK_MODELS[0],
    }),
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};
