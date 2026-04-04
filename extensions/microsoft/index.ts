import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "microsoft",
  name: "Microsoft Speech",
  description: "Bundled Microsoft speech provider",
  async register(api) {
    const { buildMicrosoftSpeechProvider } = await import("./speech-provider.js");
    api.registerSpeechProvider(buildMicrosoftSpeechProvider());
  },
});
