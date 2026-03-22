import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMicrosoftSpeechProvider } from "openclaw/plugin-sdk/speech";

export default definePluginEntry({
  id: "microsoft",
  name: "Microsoft Speech",
  description: "Bundled Microsoft speech provider",
  register(api) {
    api.registerSpeechProvider(buildMicrosoftSpeechProvider());
  },
});
