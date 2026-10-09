import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createLazyInworldRealtimeVoiceProvider } from "./realtime-voice-lazy-provider.js";
import { buildInworldSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "inworld",
  name: "Inworld Speech",
  description: "Bundled Inworld speech and realtime voice provider",
  register(api) {
    api.registerSpeechProvider(buildInworldSpeechProvider());
    api.registerRealtimeVoiceProvider(createLazyInworldRealtimeVoiceProvider());
  },
});
