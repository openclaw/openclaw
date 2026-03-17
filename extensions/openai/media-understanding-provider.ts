import { describeImageWithModel } from "../../src/media-understanding/providers/image.js";
import { transcribeOpenAiCompatibleAudio } from "../../src/media-understanding/providers/openai-compatible-audio.js";
import type { MediaUnderstandingProvider } from "../../src/media-understanding/types.js";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_AUDIO_MODEL = "gpt-4o-mini-transcribe";

export async function transcribeOpenAiAudio(
  params: import("../../src/media-understanding/types.js").AudioTranscriptionRequest,
) {
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
  transcribeAudio: transcribeOpenAiAudio,
};
