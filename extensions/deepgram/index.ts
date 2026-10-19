import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { transcribeDeepgramAudio } from "./audio.js";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

export default definePluginEntry({
  id: "deepgram",
  name: "Deepgram Media Understanding",
  description: "Bundled Deepgram audio transcription provider",
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: "deepgram",
      capabilities: ["audio"],
      defaultModels: { audio: "nova-3" },
      autoPriority: { audio: 30 },
      transcribeAudio: transcribeDeepgramAudio,
    });
    api.registerRealtimeTranscriptionProvider(buildDeepgramRealtimeTranscriptionProvider);
  },
});
