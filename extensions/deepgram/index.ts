import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_DEEPGRAM_AUDIO_MODEL, transcribeDeepgramAudio } from "./audio.js";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

export default definePluginEntry({
  id: "deepgram",
  name: "Deepgram Media Understanding",
  description: "Bundled Deepgram audio transcription provider",
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: "deepgram",
      capabilities: ["audio"],
      defaultModels: { audio: DEFAULT_DEEPGRAM_AUDIO_MODEL },
      autoPriority: { audio: 30 },
      transcribeAudio: transcribeDeepgramAudio,
    });
    api.registerRealtimeTranscriptionProvider(buildDeepgramRealtimeTranscriptionProvider);
  },
});
