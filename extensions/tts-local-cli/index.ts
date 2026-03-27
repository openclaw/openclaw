import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildCliSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "tts-local-cli",
  name: "TTS Local CLI",
  description: "Bundled TTS Local CLI provider for local text-to-speech commands",
  register(api) {
    api.registerSpeechProvider(buildCliSpeechProvider());
  },
});
