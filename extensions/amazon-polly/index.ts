import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPollySpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "amazon-polly",
  name: "Amazon Polly Speech",
  description: "Amazon Polly TTS provider with generative engine and bidirectional streaming support.",
  register(api) {
    api.registerSpeechProvider(buildPollySpeechProvider());
  },
});
