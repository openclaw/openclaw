import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildMicrosoftSpeechProvider } from "../../src/tts/providers/microsoft.js";

const microsoftPlugin = {
  id: "microsoft",
  name: "Microsoft Speech",
  description: "Bundled Microsoft speech provider",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerSpeechProvider(buildMicrosoftSpeechProvider());
  },
};

export default microsoftPlugin;
