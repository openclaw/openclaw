import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAzureSpeechProviderPlugin } from "./speech-provider.js";

export default definePluginEntry({
  id: "azure-speech",
  name: "Azure Speech",
  description: "Bundled Azure Speech TTS provider with SSML synthesis support",
  register(api) {
    api.registerSpeechProvider(buildAzureSpeechProviderPlugin());
  },
});