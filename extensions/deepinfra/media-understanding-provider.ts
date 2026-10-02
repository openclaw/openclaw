import {
  describeImageWithModel,
  describeImagesWithModel,
  transcribeOpenAiCompatibleAudio,
  type AudioTranscriptionRequest,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_STT_FALLBACK_MODELS,
  DEEPINFRA_VLM_FALLBACK_MODELS,
} from "./media-models.js";
import type { DeepInfraSurfaceModel } from "./media-models.js";

async function transcribeDeepInfraAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    provider: "deepinfra",
    defaultBaseUrl: DEEPINFRA_BASE_URL,
    defaultModel: DEEPINFRA_STT_FALLBACK_MODELS[0],
  });
}

// First entries of vlmModels / sttModels become the image / audio defaults.
export function buildDeepInfraMediaUnderstandingProvider(options?: {
  vlmModels?: readonly DeepInfraSurfaceModel[];
  sttModels?: readonly DeepInfraSurfaceModel[];
}): MediaUnderstandingProvider {
  return {
    id: "deepinfra",
    capabilities: ["image", "audio"],
    defaultModels: {
      image: options?.vlmModels?.[0]?.id ?? DEEPINFRA_VLM_FALLBACK_MODELS[0],
      audio: options?.sttModels?.[0]?.id ?? DEEPINFRA_STT_FALLBACK_MODELS[0],
    },
    autoPriority: {
      image: 45,
      audio: 45,
    },
    transcribeAudio: transcribeDeepInfraAudio,
    describeImage: describeImageWithModel,
    describeImages: describeImagesWithModel,
  };
}

// Back-compat const for callers not yet on the builder. Static fallback only.
export const deepinfraMediaUnderstandingProvider: MediaUnderstandingProvider =
  buildDeepInfraMediaUnderstandingProvider();
