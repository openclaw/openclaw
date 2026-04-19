import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { transcribeSpeechHandsAudio } from "./audio.js";

export const speechHandsMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "speech-hands",
  capabilities: ["audio"],
  defaultModels: { audio: "speech-hands-qwen2.5-omni-7b" },
  autoPriority: { audio: 40 },
  transcribeAudio: transcribeSpeechHandsAudio,
};
