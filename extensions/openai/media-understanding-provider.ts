import {
  describeImageWithModel,
  describeImagesWithModel,
  transcribeOpenAiCompatibleAudio,
  type AudioTranscriptionRequest,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models.js";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";

export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    defaultBaseUrl: DEFAULT_OPENAI_AUDIO_BASE_URL,
    defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  });
}

export const openaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openai",
  capabilities: ["image", "audio"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeOpenAiAudio,
};

async function transcribeOpenAiCodexAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiAudio({
    ...params,
    baseUrl: undefined, // force fallback to DEFAULT_OPENAI_AUDIO_BASE_URL
  });
}

export const openaiCodexMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openai-codex",
  capabilities: ["image", "audio"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeOpenAiCodexAudio,
};
