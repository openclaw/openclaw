import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildTypecastSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "typecast",
  name: "Typecast Speech",
  description: "Bundled Typecast speech provider",
  register(api) {
    api.registerSpeechProvider(buildTypecastSpeechProvider());
  },
});
