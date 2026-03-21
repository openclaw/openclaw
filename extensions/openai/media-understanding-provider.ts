import {
  describeImageWithModel,
  describeImagesWithModel,
  transcribeOpenAiCompatibleAudio,
  type AudioTranscriptionRequest,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_AUDIO_MODEL = "gpt-4o-mini-transcribe";

export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    defaultBaseUrl: DEFAULT_OPENAI_AUDIO_BASE_URL,
    defaultModel: DEFAULT_OPENAI_AUDIO_MODEL,
  });
}

export const openaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openai",
  capabilities: ["image", "audio"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeOpenAiAudio,
};
