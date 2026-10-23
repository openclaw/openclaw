import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildKokoroCppSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "kokoro-cpp",
  name: "kokoro.cpp TTS",
  description: "Bundled speech provider for a local kokoro.cpp server",
  register(api) {
    api.registerSpeechProvider(buildKokoroCppSpeechProvider());
  },
});
