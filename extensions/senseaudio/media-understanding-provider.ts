import {
  transcribeOpenAiCompatibleAudio,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

const DEFAULT_SENSEAUDIO_AUDIO_BASE_URL = "https://api.senseaudio.cn/v1";
const DEFAULT_SENSEAUDIO_AUDIO_MODEL = "senseaudio-asr-pro-1.5-260319";

export const senseaudioMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "senseaudio",
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_SENSEAUDIO_AUDIO_MODEL },
  autoPriority: { audio: 40 },
  transcribeAudio: (params) =>
    transcribeOpenAiCompatibleAudio({
      ...params,
      provider: "senseaudio",
      defaultBaseUrl: DEFAULT_SENSEAUDIO_AUDIO_BASE_URL,
      defaultModel: DEFAULT_SENSEAUDIO_AUDIO_MODEL,
    }),
};
