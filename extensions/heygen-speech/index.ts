import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildHeyGenSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "heygen-speech",
  name: "HeyGen Voice",
  description: "Hosted HeyGen Voice text-to-speech provider",
  register(api) {
    api.registerSpeechProvider(buildHeyGenSpeechProvider());
  },
});
