import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { transcribeAssemblyAIAudio } from "./audio.js";

export const assemblyaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "assemblyai",
  capabilities: ["audio"],
  defaultModels: { audio: "best" },
  autoPriority: { audio: 10 },
  transcribeAudio: transcribeAssemblyAIAudio,
};
