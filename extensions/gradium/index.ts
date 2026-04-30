import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGradiumRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildGradiumSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "gradium",
  name: "Gradium Speech",
  description: "Bundled Gradium speech provider",
  register(api) {
    api.registerSpeechProvider(buildGradiumSpeechProvider());
    api.registerRealtimeTranscriptionProvider(buildGradiumRealtimeTranscriptionProvider());
  },
});
