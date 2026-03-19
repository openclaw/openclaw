import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { buildElevenLabsSpeechProvider } from "openclaw/plugin-sdk/speech";

export default definePluginEntry({
  id: "elevenlabs",
  name: "ElevenLabs Speech",
  description: "Bundled ElevenLabs speech provider",
  register(api) {
    api.registerSpeechProvider(buildElevenLabsSpeechProvider());
  },
});
