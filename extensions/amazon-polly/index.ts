import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPollySpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "amazon-polly",
  name: "Amazon Polly Speech",
  description: "Bundled Amazon Polly speech provider",
  register(api) {
    api.registerSpeechProvider(buildPollySpeechProvider());
  },
});
