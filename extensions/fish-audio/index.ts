import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildFishAudioSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "fish-audio",
  name: "Fish Audio Speech",
  description: "Fish Audio TTS speech provider for OpenClaw",
  register(api) {
    api.registerSpeechProvider(buildFishAudioSpeechProvider());
  },
});
