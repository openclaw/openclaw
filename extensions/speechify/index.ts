import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildSpeechifySpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "speechify",
  name: "Speechify Speech",
  description: "Hosted Speechify text-to-speech provider",
  register(api) {
    api.registerSpeechProvider(buildSpeechifySpeechProvider());
  },
});
